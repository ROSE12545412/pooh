import test from 'node:test';
import assert from 'node:assert/strict';
import { mercyDialog, closeModal, openModal } from '../src/ui/dom.js';

class Element {
    constructor(tag) {
        this.nodeType = 1; this.tagName = tag; this.children = []; this.handlers = {}; this.attributes = {};
        this.classes = new Set(); this.classList = { add: (...values) => values.forEach(value => this.classes.add(value)) };
    }
    setAttribute(key, value) { this.attributes[key] = value; if (key === 'id') this.id = value; }
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
    get textContent() { return this.children.map(child => child.textContent || '').join(''); }
    set textContent(value) { this.children = [{ textContent: String(value) }]; }
    addEventListener(type, handler) { (this.handlers[type] ||= new Set()).add(handler); }
    removeEventListener(type, handler) { this.handlers[type]?.delete(handler); }
    fire(type, extra = {}) { for (const handler of [...(this.handlers[type] || [])]) handler({ target: this, preventDefault() {}, stopPropagation() {}, ...extra }); }
    querySelector(selector) { return nodes(this).find(node => selector.startsWith('.') ? node.classes?.has(selector.slice(1)) : node.id === selector.slice(1)); }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; }
    get isConnected() { return Boolean(this.parentNode); }
}
const nodes = root => [root, ...(root.children || []).flatMap(nodes)];
function harness(t) {
    const original = globalThis.document;
    const doc = new Element('document'); doc.body = new Element('body');
    doc.createElement = tag => new Element(tag);
    doc.createTextNode = text => ({ nodeType: 3, nodeName: '#text', textContent: String(text) });
    globalThis.document = doc;
    t.after(() => { closeModal(); if (original === undefined) delete globalThis.document; else globalThis.document = original; });
    return doc;
}

for (const [id, value] of [['td-mercy-choose', 'mercy'], ['td-mercy-continue', 'continue'], ['td-mercy-cancel', 'cancel']]) {
    test(`mercyDialog explicit button ${id} returns ${value} and cleans modal/listeners`, async t => {
        const doc = harness(t);
        const controller = new AbortController();
        let listeners = 0;
        const signal = { get aborted() { return controller.signal.aborted; },
            addEventListener(...args) { listeners++; controller.signal.addEventListener(...args); },
            removeEventListener(...args) { listeners--; controller.signal.removeEventListener(...args); } };
        const result = mercyDialog({ actorName: '玩家', targetName: '<敌人>', skillName: '斩击', isPlayer: true, signal });
        assert.match(doc.body.textContent, /是否留手/);
        assert.match(doc.body.textContent, /<敌人>/);
        doc.body.querySelector('#' + id).fire('click');
        assert.equal(await result, value);
        assert.equal(doc.body.children.length, 0);
        assert.equal(doc.handlers.keydown.size, 0);
        assert.equal(listeners, 0);
    });
}
for (const method of ['close', 'escape', 'overlay', 'abort', 'replace']) {
    test(`mercyDialog ${method} always cancels rather than continuing lethal attack`, async t => {
        const doc = harness(t);
        const controller = new AbortController();
        const result = mercyDialog({ actorName: '友方', targetName: '敌人', isPlayer: false, signal: controller.signal });
        assert.match(doc.body.textContent, /是否阻止友方/);
        assert.ok(doc.body.textContent.includes('尝试阻止'));
        if (method === 'close') doc.body.querySelector('.td-modal-close').fire('click');
        if (method === 'escape') doc.fire('keydown', { key: 'Escape' });
        if (method === 'overlay') doc.body.children[0].fire('click');
        if (method === 'abort') controller.abort();
        if (method === 'replace') openModal({ title: '其他弹窗', body: doc.createElement('div') });
        assert.equal(await result, 'cancel');
        closeModal();
        assert.equal(doc.handlers.keydown.size, 0);
    });
}
test('mercyDialog pre-aborted and DOM failures fail closed without confirm fallback', async t => {
    const doc = harness(t);
    const controller = new AbortController(); controller.abort();
    assert.equal(await mercyDialog({ signal: controller.signal }), 'cancel');
    assert.equal(doc.body.children.length, 0);
    doc.createElement = () => { throw new Error('DOM unavailable'); };
    assert.equal(await mercyDialog({}), 'cancel');
});
