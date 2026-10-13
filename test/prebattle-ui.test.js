import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPrebattle } from '../src/ui/prebattle.js';

class Element {
    constructor(tag) { this.nodeType = 1; this.tagName = tag; this.children = []; this.attributes = {}; this.handlers = {}; this.checked = false; this.disabled = false; this.open = false; this.classList = { add: (...classes) => { this.classes = [...(this.classes || []), ...classes]; } }; }
    setAttribute(key, value) { this.attributes[key] = value; if (key === 'id') this.id = value; }
    appendChild(child) { this.children.push(child); return child; }
    addEventListener(type, handler) { (this.handlers[type] ||= []).push(handler); }
    get textContent() { return this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this.children = [{ textContent: value }]; }
    fire(type) { for (const handler of this.handlers[type] || []) handler({ preventDefault() {}, stopPropagation() {} }); }
}
const nodes = root => [root, ...(root.children || []).flatMap(nodes)];
const byId = (root, id) => nodes(root).find(node => node.id === id);
const choice = (root, id, kind) => nodes(root).find(node => node.tagName === 'input' && node.attributes['data-entry-id'] === id && (!kind || node.attributes['data-kind'] === kind));
const settle = () => new Promise(resolve => setImmediate(resolve));
function harness(t) {
    const old = globalThis.document;
    globalThis.document = { createElement: tag => new Element(tag), createTextNode: text => ({ nodeType: 3, nodeName: '#text', textContent: text }) };
    t.after(() => { if (old === undefined) delete globalThis.document; else globalThis.document = old; });
    const rule = { equipment: { slot: 'weapon', bonuses: [] } };
    const app = { busy: false, prebattleSelection: { skills: [], weapon: null, armor: null, accessories: [], accessoryMode: 'story' }, loadoutEntries: [
        { id: 's', kind: 'skill', name: '技能甲', description: '技能描述', rule: { skill: { name: '技能甲', effects: [] } } },
        { id: 'u', kind: 'skill', name: '未润色技能', description: '待润色' },
        { id: 'w', kind: 'weapon', name: '剑', description: '剑描述', rule },
        { id: 'a', kind: 'armor', name: '铠甲', description: '', rule },
        ...['x', 'y', 'z'].map(id => ({ id, kind: 'accessory', name: id, description: '饰品描述', rule })),
    ] };
    const calls = [];
    app.setPrebattleSelection = async (kind, value) => { calls.push([kind, value]); const s = app.prebattleSelection; if (kind === 'skill') s.skills = value; else if (kind === 'accessory') { s.accessories = value; s.accessoryMode = value.length ? 'custom' : 'none'; } else s[kind] = value; return { ok: true }; };
    let root;
    const helpers = { rerender() { root = renderPrebattle(app, helpers); } };
    helpers.rerender();
    return { app, calls, render: helpers.rerender, get root() { return root; } };
}

test('prebattle: four drawers show every entry, unrefined disabled and empty library explained', t => {
    const h = harness(t);
    assert.equal(nodes(h.root).filter(n => n.tagName === 'details').length, 4);
    assert.equal(choice(h.root, 'u').disabled, true);
    assert.ok(h.root.textContent.includes('先在自定义库润色'));
    assert.ok(h.root.textContent.includes('技能描述'));
    assert.equal(choice(h.root, 'story', 'weapon').checked, true);
    assert.equal(choice(h.root, 'story', 'armor').checked, true);
    h.app.loadoutEntries = []; h.render();
    for (const word of ['没有技能', '没有武器', '没有防具', '没有饰品']) assert.ok(h.root.textContent.includes(word));
});

test('prebattle: skill all selects only executable entries and clear uses ID array', async t => {
    const h = harness(t);
    byId(h.root, 'td-prebattle-skills-all').fire('click'); await settle();
    assert.deepEqual(h.calls[0], ['skill', ['s']]);
    assert.equal(choice(h.root, 's').checked, true);
    byId(h.root, 'td-prebattle-skills-clear').fire('click'); await settle();
    assert.deepEqual(h.calls[1], ['skill', []]);
    choice(h.root, 's').checked = true; choice(h.root, 's').fire('change'); await settle();
    assert.deepEqual(h.calls[2], ['skill', ['s']]);
});

test('prebattle: weapon and armor radio select IDs or story null', async t => {
    const h = harness(t);
    for (const [id, kind] of [['w', 'weapon'], ['a', 'armor']]) {
        choice(h.root, id).checked = true; choice(h.root, id).fire('change'); await settle();
        assert.deepEqual(h.calls.at(-1), [kind, id]);
        const story = choice(h.root, 'story', kind); story.checked = true; story.fire('change'); await settle();
        assert.deepEqual(h.calls.at(-1), [kind, null]);
    }
});

test('prebattle: accessories cap two without preventing removal, none and restore story distinct', async t => {
    const h = harness(t);
    for (const id of ['x', 'y']) { choice(h.root, id).checked = true; choice(h.root, id).fire('change'); await settle(); }
    assert.deepEqual(h.calls.at(-1), ['accessory', ['x', 'y']]);
    assert.equal(choice(h.root, 'z').disabled, true);
    assert.equal(choice(h.root, 'x').disabled, false);
    choice(h.root, 'z').checked = true; choice(h.root, 'z').fire('change'); await settle();
    assert.equal(h.calls.length, 2);
    choice(h.root, 'x').checked = false; choice(h.root, 'x').fire('change'); await settle();
    assert.deepEqual(h.calls.at(-1), ['accessory', ['y']]);
    byId(h.root, 'td-prebattle-accessories-none').fire('click'); await settle();
    assert.equal(h.app.prebattleSelection.accessoryMode, 'none');
    byId(h.root, 'td-prebattle-accessories-story').fire('click'); await settle();
    assert.deepEqual(h.calls.at(-1), ['accessoryMode', 'story']);
    assert.ok(h.root.textContent.includes('饰品 · 使用正文'));
});

test('prebattle: busy controls cannot mutate settings and drawers retain open independently', t => {
    const h = harness(t);
    const drawers = nodes(h.root).filter(n => n.tagName === 'details');
    drawers[0].open = true; drawers[0].fire('toggle'); h.render();
    assert.equal(nodes(h.root).filter(n => n.tagName === 'details')[0].open, true);
    h.app.busy = true; h.render();
    assert.ok(nodes(h.root).filter(n => n.tagName === 'input').every(n => n.disabled));
    byId(h.root, 'td-prebattle-accessories-none').fire('click');
    choice(h.root, 's').checked = true; choice(h.root, 's').fire('change');
    assert.deepEqual(h.calls, []);
    const other = { ...h.app };
    assert.equal(nodes(renderPrebattle(other, { rerender() {} })).filter(n => n.tagName === 'details')[0].open, false);
});

test('prebattle: failed update toasts and redraws authoritative selection', async t => {
    const h = harness(t);
    const old = globalThis.toastr; const messages = [];
    globalThis.toastr = { warning: message => messages.push(message), error: message => messages.push(message) };
    t.after(() => { if (old === undefined) delete globalThis.toastr; else globalThis.toastr = old; });
    h.app.setPrebattleSelection = async () => ({ ok: false, error: '选择失败' });
    choice(h.root, 'w').checked = true; choice(h.root, 'w').fire('change'); await settle();
    assert.equal(choice(h.root, 'w').checked, false);
    assert.deepEqual(messages, ['选择失败']);
});

test('prebattle: rapid checks use latest selection before persistence finishes', async t => {
    const h = harness(t);
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    h.app.setPrebattleSelection = async (kind, value) => {
        h.calls.push([kind, value]);
        h.app.prebattleSelection = { ...h.app.prebattleSelection, accessories: value, accessoryMode: 'custom' };
        await pending;
        return { ok: true };
    };
    const x = choice(h.root, 'x'), y = choice(h.root, 'y'), z = choice(h.root, 'z');
    x.checked = true; x.fire('change');
    y.checked = true; y.fire('change');
    assert.deepEqual(h.calls, [['accessory', ['x']], ['accessory', ['x', 'y']]]);
    z.checked = true; z.fire('change');
    assert.equal(z.checked, false);
    assert.equal(h.calls.length, 2);
    release(); await settle();
    assert.equal(choice(h.root, 'x').checked, true);
    assert.equal(choice(h.root, 'y').checked, true);
});

test('prebattle: same-name accessories disabled and stale choice checks live selection', async t => {
    const h = harness(t);
    h.app.loadoutEntries.find(e => e.id === 'y').name = ' x ';
    h.render();
    const staleY = choice(h.root, 'y');
    choice(h.root, 'x').checked = true; choice(h.root, 'x').fire('change'); await settle();
    assert.equal(choice(h.root, 'y').disabled, true);
    staleY.checked = true; staleY.fire('change');
    assert.equal(staleY.checked, false);
    assert.equal(h.calls.length, 1);
    assert.ok(h.root.textContent.includes('战前装备（可选）'));
});
