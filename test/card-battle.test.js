import test from 'node:test';
import assert from 'node:assert/strict';
import { renderBattle } from '../src/ui/battle.js';

class Element {
    constructor(tag) {
        this.nodeType = 1; this.tagName = tag; this.children = []; this.attributes = {}; this.handlers = {};
        this.style = {}; this.value = ''; this.disabled = false; this.classes = new Set();
        this.classList = { add: (...values) => values.forEach(value => this.classes.add(value)) };
    }
    setAttribute(key, value) { this.attributes[key] = value; if (key === 'id') this.id = value; }
    removeAttribute(key) { delete this.attributes[key]; if (key === 'id') delete this.id; }
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
    get isConnected() { return this.connected === true || Boolean(this.parentNode?.isConnected); }
    focus() { this.focused = true; }
    remove() { this.parentNode?.removeChild(this); }
    cloneNode(deep) {
        const copy = new Element(this.tagName); copy.attributes = { ...this.attributes }; copy.classes = new Set(this.classes);
        if (deep) for (const child of this.children) copy.appendChild(child.cloneNode ? child.cloneNode(true) : { ...child });
        return copy;
    }
    querySelector(selector) { return nodes(this).find(node => node.classes?.has(selector.slice(1))) || null; }
    setPointerCapture(id) { this.pointerId = id; }
    hasPointerCapture(id) { return this.pointerId === id; }
    releasePointerCapture() { delete this.pointerId; }
    get textContent() { return this.children.map(child => child.textContent || '').join(''); }
    set textContent(value) { this.children = [{ textContent: String(value) }]; }
    addEventListener(type, handler) { (this.handlers[type] ||= []).push(handler); }
    fire(type, extra = {}) { for (const handler of this.handlers[type] || []) handler({ target: this, preventDefault() {}, stopPropagation() {}, ...extra }); }
    get firstChild() { return this.children[0]; }
    removeEventListener(type, handler) { this.handlers[type] = (this.handlers[type] || []).filter(item => item !== handler); }
    removeChild(child) { this.children = this.children.filter(item => item !== child); child.parentNode = null; }
    closest(selector) {
        const matches = selector.split(',').map(s => s.trim());
        if (matches.some(s => s === this.tagName || (s.startsWith('.') && this.classes.has(s.slice(1))) ||
            (s === '[role="button"]' && this.attributes.role === 'button'))) return this;
        return this.parentNode?.closest?.(selector) || null;
    }
}
const nodes = root => [root, ...(root.children || []).flatMap(nodes)];
const css = (root, name) => nodes(root).find(node => node.classes?.has(name));
const settle = () => new Promise(resolve => setImmediate(resolve));
function harness(t) {
    const old = globalThis.document; const oldWindow = globalThis.window;
    const body = new Element('body'); body.connected = true;
    globalThis.document = Object.assign(new Element('document'), { body,
        createElement: tag => new Element(tag), createTextNode: text => ({ nodeType: 3, nodeName: '#text', textContent: String(text) }) });
    globalThis.window = new Element('window');
    t.after(() => { document.fire('keydown', { key: 'Escape' });
        if (old === undefined) delete globalThis.document; else globalThis.document = old;
        if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow;
    });
    const skills = ['single', 'self', 'group', 'all', 'random'].map(target => ({ id: target, name: target, target, cost: 0, power: 1, effects: [{ type: target === 'self' ? 'heal' : 'damage' }] }));
    const unit = (id, side) => ({ id, name: id, side, alive: true, attributes: { HP: { current: 30, max: 50 }, MP: { current: 10, max: 20 } }, skills: [], statuses: [] });
    const player = unit('player', 'ally'); player.skills = skills;
    const ally = unit('ally', 'ally');
    const enemy = unit('enemy', 'enemy'); const neutral = unit('neutral', 'neutral');
    const spectator = unit('spectator', 'enemy'); spectator.mercyWithdrawn = true;
    const battle = { units: [player, ally, enemy, neutral, spectator], currentUnit: player, phase: 'active', round: 1, turnIndex: 0, log: [], initiative: [], ruleset: {},
        targetCandidates(actor, skill) { return !actor.alive ? [] : skill.target === 'self' ? [actor] : this.units.filter(u => u.side === 'enemy' && u.alive && !u.mercyWithdrawn); } };
    const calls = []; const switches = []; let owner = 'player';
    const app = { battle, ctx: { chatId: 'chat', chatMetadata: {} }, busy: false, ruleset: { name: 'test' }, settings: { battle: { showDice: false } },
        isUserUnit: u => u?.id === owner, _maybeContinueAutoDrive() {},
        setUserUnit: async name => { switches.push(name); owner = name; return { ok: true }; },
        playPlayerTurn: async action => { calls.push(action); return { ok: true }; } };
    let root; const helpers = { rerender() { root?.remove(); root = renderBattle(app, helpers); body.appendChild(root); } }; helpers.rerender();
    return { app, battle, calls, switches, player, ally, enemy, render: helpers.rerender, get root() { return root; },
        card(id) { return nodes(root).find(n => n.id === 'td-bunit-' + id); },
        skill(id) { return nodes(root).find(node => node.attributes?.['data-skill-id'] === id); },
        target() { return nodes(root).find(node => node.attributes?.['data-target-id'] === 'enemy' && node.attributes?.role === 'button'); },
        execute() { return css(root, 'td-execute-action'); } };
}

test('card battle: arena side/center/auxiliary and dock preserve resources, details and banter', t => {
    const h = harness(t);
    assert.ok(css(h.root, 'td-card-table'));
    const arena = css(h.root, 'td-card-arena');
    assert.deepEqual(arena.children.map(n => [...n.classes][0]), ['td-card-side', 'td-card-center', 'td-card-side', 'td-battle-units']);
    assert.match(css(arena, 'td-card-allies').textContent, /player/);
    assert.match(css(arena, 'td-card-enemies').textContent, /enemy/);
    assert.doesNotMatch(css(arena, 'td-card-enemies').textContent, /spectator/);
    assert.match(css(arena, 'td-card-auxiliary').textContent, /neutral.*spectator/s);
    for (const cls of ['td-initiative', 'td-blog-wrap']) assert.ok(css(css(arena, 'td-card-center'), cls));
    assert.ok(css(css(h.root, 'td-card-dock'), 'td-action-bar'));
    assert.ok(css(css(h.root, 'td-card-dock'), 'td-banter'));
    const card = nodes(h.root).find(n => n.id === 'td-bunit-player');
    assert.ok(card.classes.has('td-character-card'));
    assert.equal(css(card, 'td-card-hp').textContent, '生命 HP30/50');
    assert.equal(css(card, 'td-card-mp').textContent, '魔量 MP10/20');
    assert.equal(css(card, 'td-resource-toggle'), undefined);
    assert.equal(css(card, 'td-unit-details').hidden, true);
    assert.equal(css(card, 'td-portrait').tagName, 'div');
    assert.equal(css(card, 'td-portrait-edit').tagName, 'button');
    assert.ok(css(h.root, 'td-compact-table'));
    assert.equal(nodes(css(h.root, 'td-user-picker')).some(n => n.attributes?.role === 'button'), false);
    assert.ok(css(h.root, 'td-skill-hand'));
});

test('card battle: single skill waits then avatar immediately submits once', async t => {
    const h = harness(t);
    h.skill('single').fire('click');
    assert.equal(h.calls.length, 0); assert.equal(h.execute(), undefined);
    assert.ok(h.skill('single').classes.has('td-skill-selected'));
    assert.equal(h.target(), undefined);
    assert.doesNotMatch(h.root.textContent, /选为目标/);
    const card = h.card('enemy');
    card.fire('click', { target: css(card, 'td-portrait') }); card.fire('click'); await settle();
    assert.deepEqual(h.calls, [{ skillId: 'single', action: 'skill', targetIds: ['enemy'] }]);
});

for (const target of ['self', 'group', 'all', 'random']) test(`card battle: ${target} waits for explicit confirmation and uses engine targeting`, async t => {
    const h = harness(t); h.skill(target).fire('click');
    assert.equal(h.calls.length, 0); assert.equal((h.execute().attributes['aria-disabled'] === 'true'), false);
    assert.equal(h.target(), undefined);
    if (target === 'self') assert.ok(nodes(h.root).find(n => n.id === 'td-bunit-player').classes.has('td-bunit-selected'));
    h.execute().fire('click'); await settle();
    assert.deepEqual(h.calls, [{ skillId: target, action: 'skill' }]);
});

for (const change of ['busy', '_autoDriving', '_playerTurnRunning', 'finished', 'target', 'skill', 'turn', 'chat', 'battle', 'actor']) test(`card battle: execution revalidates ${change}`, async t => {
    const h = harness(t); h.skill('single').fire('click'); const submit = h.card('enemy');
    if (['busy', '_autoDriving', '_playerTurnRunning'].includes(change)) h.app[change] = true;
    if (change === 'finished') h.battle.phase = 'finished';
    if (change === 'target') h.enemy.alive = false;
    if (change === 'skill') h.player.skills[0].cost = 1000;
    if (change === 'turn') h.battle.turnIndex++;
    if (change === 'chat') h.app.ctx.chatMetadata = {};
    if (change === 'battle') h.app.battle = { ...h.battle };
    if (change === 'actor') h.player.alive = false;
    submit.fire('click'); await settle(); assert.equal(h.calls.length, 0);
});

test('card battle: basic attack also executes from avatar after selection', async t => {
    const h = harness(t); h.skill('').fire('click'); assert.equal(h.calls.length, 0);
    const card = h.card('enemy'); card.fire('click', { target: css(card, 'td-portrait') }); await settle();
    assert.deepEqual(h.calls, [{ skillId: '', action: 'attack', targetIds: ['enemy'] }]);
});

for (const change of ['turn', 'chat']) test(`card battle: stale skill card cannot create a new pending on ${change}`, t => {
    const h = harness(t); const skill = h.skill('single');
    if (change === 'turn') h.battle.turnIndex++;
    else h.app.ctx.chatMetadata = {};
    skill.fire('click'); h.render(); h.card('enemy').fire('click');
    assert.equal(css(h.root, 'td-skill-selected'), undefined); assert.deepEqual(h.calls, []);
});

test('card battle: text-only skill metadata and visible disabled reason', t => {
    const h = harness(t); h.player.skills[0].name = '<img onerror=attack()>'; h.player.skills[0].cost = 999; h.render();
    const skill = h.skill('single'); assert.equal(skill.attributes['aria-disabled'], 'true');
    assert.ok(css(skill, 'td-skill-disabled-reason').textContent);
    assert.match(css(skill, 'td-skill-name').textContent, /<img onerror=attack\(\)>/);
    assert.equal(nodes(skill).some(n => n.tagName === 'img'), false);
});

test('card battle: no skill and illegal card clicks cannot execute', async t => {
    const h = harness(t); h.card('enemy').fire('click'); assert.equal(h.calls.length, 0);
    h.skill('single').fire('click'); h.card('neutral').fire('click'); await settle();
    assert.equal(h.calls.length, 0);
});

test('card battle: submission blocks new skills even when app busy stays false', async t => {
    const h = harness(t); let finish;
    h.app.playPlayerTurn = action => { h.calls.push(action); return new Promise(resolve => { finish = resolve; }); };
    h.skill('single').fire('click'); const enemy = h.card('enemy'); enemy.fire('click');
    h.skill('self').fire('click'); enemy.fire('click');
    assert.equal(h.calls.length, 1); assert.equal(h.execute(), undefined);
    finish({ ok: true }); await settle();
    h.skill('self').fire('click'); assert.ok(h.execute());
});

test('card gestures: long press opens modal, suppresses click/double and Escape closes', t => {
    const h = harness(t); t.mock.timers.enable({ apis: ['setTimeout'] });
    h.skill('single').fire('click'); const card = h.card('enemy');
    card.fire('pointerdown', { button: 0, isPrimary: true, pointerId: 1, clientX: 0, clientY: 0 });
    t.mock.timers.tick(549); assert.equal(css(document.body, 'td-overlay'), undefined);
    t.mock.timers.tick(1); assert.ok(css(document.body, 'td-overlay'));
    assert.equal(css(card, 'td-unit-details').hidden, true);
    card.fire('click'); card.fire('dblclick'); assert.deepEqual(h.switches, []); assert.deepEqual(h.calls, []);
    document.fire('keydown', { key: 'Escape' }); assert.equal(css(document.body, 'td-overlay'), undefined);
    assert.equal((window.handlers.blur || []).length, 0);
});

for (const cancel of ['pointerup', 'pointercancel', 'pointerleave', 'move', 'blur', 'windowblur', 'turn', 'chat', 'disconnect', 'secondary']) {
    test(`card gestures: long press cancels on ${cancel}`, t => {
        const h = harness(t); t.mock.timers.enable({ apis: ['setTimeout'] }); const card = h.card('ally');
        card.fire('pointerdown', { button: cancel === 'secondary' ? 2 : 0, isPrimary: true, pointerId: 1, clientX: 0, clientY: 0 });
        if (cancel === 'move') card.fire('pointermove', { pointerId: 1, clientX: 9, clientY: 0 });
        else if (cancel === 'windowblur') window.fire('blur');
        else if (cancel === 'turn') h.battle.turnIndex++;
        else if (cancel === 'chat') h.app.ctx.chatMetadata = {};
        else if (cancel === 'disconnect') card.remove();
        else card.fire(cancel);
        t.mock.timers.tick(550); assert.equal(css(document.body, 'td-overlay'), undefined);
        assert.deepEqual(h.calls, []); assert.equal((window.handlers.blur || []).length, 0);
    });
}

test('card gestures: double switches without acting, current player never deselects', async t => {
    const h = harness(t); const card = h.card('ally');
    card.fire('dblclick'); await settle(); assert.deepEqual(h.switches, ['ally']); assert.deepEqual(h.calls, []);
    h.card('ally').fire('dblclick'); await settle(); assert.deepEqual(h.switches, ['ally']);
});

for (const block of ['busy', '_autoDriving', '_playerTurnRunning', 'finished', 'dead', 'withdrawn']) {
    test(`card gestures: double switch rejects ${block}`, async t => {
        const h = harness(t);
        if (block === 'finished') h.battle.phase = 'finished';
        else if (block === 'dead') h.ally.alive = false;
        else if (block === 'withdrawn') h.ally.mercyWithdrawn = true;
        else h.app[block] = true;
        h.card('ally').fire('dblclick'); await settle(); assert.deepEqual(h.switches, []); assert.deepEqual(h.calls, []);
    });
}

test('card gestures: keyboard executes single, Space inspects, Shift+Enter switches', async t => {
    const h = harness(t); h.skill('single').fire('click');
    h.card('enemy').fire('keydown', { key: 'Enter' }); await settle(); assert.equal(h.calls.length, 1);
    assert.equal(h.execute(), undefined);
    h.card('player').fire('keydown', { key: ' ' }); assert.ok(css(document.body, 'td-overlay'));
    document.fire('keydown', { key: 'Escape' });
    h.card('ally').fire('keydown', { key: 'Enter', shiftKey: true }); await settle();
    assert.deepEqual(h.switches, ['ally']); assert.equal(h.calls.length, 1);
});

test('card gestures: allied healing single waits; double cancels execution and only switches', async t => {
    const h = harness(t); t.mock.timers.enable({ apis: ['setTimeout'] });
    h.player.skills[0].effects = [{ type: 'heal' }];
    h.battle.targetCandidates = () => [h.player, h.ally]; h.skill('single').fire('click');
    const card = h.card('ally'); card.fire('click');
    assert.equal(h.card('ally'), card); assert.equal(h.execute(), undefined); assert.equal(h.calls.length, 0);
    card.fire('click'); card.fire('dblclick'); await settle(); t.mock.timers.tick(400);
    assert.deepEqual(h.switches, ['ally']); assert.deepEqual(h.calls, []);
});

test('card gestures: allied healing executes after 400ms; stale delayed target cannot submit', async t => {
    const h = harness(t); t.mock.timers.enable({ apis: ['setTimeout'] });
    h.player.skills[0].effects = [{ type: 'heal' }];
    h.battle.targetCandidates = () => [h.player, h.ally]; h.skill('single').fire('click');
    h.card('ally').fire('click'); t.mock.timers.tick(399); assert.deepEqual(h.calls, []);
    t.mock.timers.tick(1); await settle();
    assert.deepEqual(h.calls, [{ skillId: 'single', action: 'skill', targetIds: ['ally'] }]);
    h.calls.length = 0;
    h.skill('single').fire('click'); h.card('ally').fire('click'); h.app.ctx.chatMetadata = {};
    t.mock.timers.tick(400); assert.deepEqual(h.calls, []);
});

test('card gestures: delayed ally click cannot consume a newer skill selection', t => {
    const h = harness(t); t.mock.timers.enable({ apis: ['setTimeout'] });
    h.battle.targetCandidates = () => [h.player, h.ally]; h.skill('single').fire('click');
    h.card('ally').fire('click'); h.skill('single').fire('click'); t.mock.timers.tick(400);
    assert.deepEqual(h.calls, []);
});

test('card gestures: portrait edit is excluded but portrait surface supports long press', t => {
    const h = harness(t); t.mock.timers.enable({ apis: ['setTimeout'] }); h.skill('single').fire('click'); const card = h.card('enemy');
    card.fire('click', { target: css(card, 'td-portrait-edit') }); assert.deepEqual(h.calls, []);
    card.fire('pointerdown', { target: css(card, 'td-portrait-edit'), button: 0, pointerId: 1 });
    t.mock.timers.tick(550); assert.equal(css(document.body, 'td-overlay'), undefined);
    card.fire('pointerdown', { target: css(card, 'td-portrait'), button: 0, pointerId: 1, clientX: 0, clientY: 0 });
    t.mock.timers.tick(550); assert.ok(css(document.body, 'td-overlay'));
});

test('card battle: turn change clears skill and target pending without acting', t => {
    const h = harness(t); h.skill('single').fire('click');
    h.battle.round++; h.render();
    assert.equal(h.execute(), undefined);
    assert.equal(css(h.root, 'td-bunit-selected'), undefined);
    assert.equal(css(h.root, 'td-skill-selected'), undefined);
    assert.equal(h.calls.length, 0);
});
