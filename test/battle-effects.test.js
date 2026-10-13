import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBattleVisual, playBattleVisual } from '../src/ui/battle-effects.js';
import { Battle } from '../src/combat/engine.js';
import { normalizeCombatant } from '../src/core/schema.js';
import { normalizeRuleset } from '../src/core/ruleset.js';

const actor = effects => ({ id: 'actor', skills: [{ id: 'skill', name: '火焰术', effects }] });
const attack = (id, outcome, extra = {}) => ({ type: 'attack', data: { targetId: id, hit: { outcome, nat: 20, ...extra }, damage: { damage: 8 } } });
const build = (effects, entries) => buildBattleVisual({}, actor(effects), { skillId: 'skill' }, entries);

test('battle visual: engine outcomes, never natural 20 or descriptive text, decide success', () => {
    const miss = build([{ type: 'damage' }], [attack('enemy', 'miss')]);
    assert.equal(miss.outcome, 'miss'); assert.equal(miss.focus, false);
    assert.equal(miss.theme, 'fire'); assert.equal(miss.targets[0].success, false);
    const hit = build([{ type: 'damage' }], [attack('enemy', 'hit', { nat: 1 })]);
    assert.equal(hit.outcome, 'hit'); assert.equal(hit.focus, true);
    const crit = build([{ type: 'damage' }], [attack('enemy', 'hit', { override: 'crit', nat: 4 })]);
    assert.equal(crit.outcome, 'crit'); assert.match(crit.label, /大成功/);
    const fumble = build([{ type: 'damage' }], [attack('enemy', 'hit', { override: 'fumble' })]);
    assert.equal(fumble.outcome, 'fumble'); assert.equal(fumble.focus, false);
});

test('battle visual: mixed area targets preserve individual successes and failures', () => {
    const event = build([{ type: 'damage' }], [attack('a', 'hit'), attack('b', 'miss'), attack('c', 'fumble')]);
    assert.deepEqual(event.targets.map(t => [t.id, t.success, t.outcome]), [['a', true, 'hit'], ['b', false, 'miss'], ['c', false, 'fumble']]);
    assert.equal(event.focus, true);
});

test('battle visual: actual effects classify heal/shield/control/poison, saves do not attack', () => {
    for (const [type, expected] of [['shield', 'shield'], ['control', 'control'], ['dot', 'poison'], ['buff', 'status']]) {
        const event = build([{ type }], [{ type: 'status', data: { targetId: 'e', status: { type } } }]);
        assert.equal(event.types[0], expected); assert.equal(event.focus, false);
    }
    const heal = build([{ type: 'heal' }], [{ type: 'heal', data: { targetId: 'a', healed: 5 } }]);
    assert.equal(heal.theme, 'heal'); assert.equal(heal.focus, false);
    assert.equal(build([{ type: 'control' }], [{ type: 'status', data: { targetId: 'a', check: { checkKind: 'control', outcome: 'hit', override: 'crit' } } }]), null);
    assert.equal(build([{ type: 'heal' }], [attack('a', 'hit')]).types.includes('damage'), false);
    assert.equal(build([{ type: 'damage' }], []), null);
});

test('battle visual: real Battle.act structured action logs yield a pure snapshot', () => {
    const unit = (id, side, skills = []) => normalizeCombatant({ id, name: id, side, attributes: { HP: { current: 100, max: 100 }, MP: { current: 50, max: 50 }, Atk: 10, Armor: 0, Speed: 10, Evasion: 0 }, skills });
    const a = unit('a', 'ally', [{ id: 'skill', name: '冰霜', effects: [{ type: 'damage', power: 5 }], power: 5, aim: 100, target: 'single' }]);
    const e = unit('e', 'enemy');
    const battle = new Battle({ combatants: [a, e] }, { seed: 42, ruleset: normalizeRuleset({ hitFormula: '100', hitTargetFormula: '1', critFormula: 'false', fumbleFormula: 'false' }) });
    battle.start();
    const acting = battle.currentUnit;
    const target = battle.units.find(u => u.id !== acting.id);
    const action = { skillId: acting.skills[0]?.id, targetIds: [target.id] };
    const start = battle.log.length;
    const result = battle.act(action); assert.equal(result.ok, true);
    const entries = battle.log.slice(start); const turn = entries.findIndex(e => e.type === 'turn');
    const before = JSON.stringify(battle.toState());
    const event = buildBattleVisual(battle, acting, action, turn < 0 ? entries : entries.slice(0, turn));
    assert.ok(event); assert.equal(event.targets[0].id, target.id);
    assert.equal(JSON.stringify(battle.toState()), before);
});

class Node {
    constructor(classes = [], id = '') {
        this.classes = new Set(classes); this.id = id; this.children = []; this.handlers = {}; this.dataset = {};
        this.classList = { add: (...xs) => xs.forEach(x => this.classes.add(x)), remove: (...xs) => xs.forEach(x => this.classes.delete(x)) };
        const props = {}; this.style = { setProperty: (k, v) => { props[k] = v; }, getPropertyValue: k => props[k] || '', removeProperty: k => { delete props[k]; } };
        this.ownerDocument = { createElement: () => new Node() };
    }
    get isConnected() { return this.connected === true || Boolean(this.parent?.isConnected); }
    appendChild(n) { n.parent = this; this.children.push(n); return n; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; }
    all() { return [this, ...this.children.flatMap(n => n.all())]; }
    querySelectorAll(s) { return this.all().filter(n => n.classes.has(s.slice(1))); }
    querySelector(s) { return this.querySelectorAll(s)[0]; }
    closest(s) { return this.classes.has(s.slice(1)) ? this : this.parent?.closest(s); }
    addEventListener(t, fn) { (this.handlers[t] ||= []).push(fn); }
    removeEventListener(t, fn) { this.handlers[t] = (this.handlers[t] || []).filter(f => f !== fn); }
    getBoundingClientRect() { return this.rect ?? { top: 0, height: 100 }; }
}
const flush = () => new Promise(resolve => queueMicrotask(resolve));
function dom() {
    const root = new Node(); const side = root.appendChild(new Node(['td-card-side']));
    side.clientHeight = 100; side.scrollHeight = 500; side.scrollTop = 0; side.scrollTo = options => { side.scrolled = options; };
    const card = side.appendChild(new Node(['td-character-card'], 'td-bunit-actor')); card.rect = { top: 250, height: 80 }; card.offsetHeight = 80;
    root.appendChild(new Node(['td-bg3-panel']));
    const ctx = { chatMetadata: {} }; const battle = {};
    const app = { ctx, battle, battleVisual: { ...buildBattleVisual(battle, actor([{ type: 'damage' }]), { skillId: 'skill' }, [attack('e', 'crit')]), seq: 1, ctx, metadata: ctx.chatMetadata } };
    return { root, card, side, app };
}
test('battle visual: disconnected render does not consume; connected event plays once and scrolls only side', async () => {
    const h = dom(); playBattleVisual(h.root, h.app); await flush();
    assert.equal(h.card.classes.has('td-fx-actor'), false);
    h.root.connected = true; playBattleVisual(h.root, h.app); await flush();
    assert.equal(h.card.classes.has('td-fx-actor'), true); assert.equal(h.card.classes.has('td-fx-crit'), true);
    assert.equal(h.side.scrolled.top, 230);
    assert.equal(h.card.children[0].dataset.outcome, 'crit');
    for (const fn of [...h.card.handlers.animationend]) fn({ target: h.card, elapsedTime: 1.2 });
    assert.equal(h.card.children.length, 0);
    playBattleVisual(h.root, h.app); await flush(); assert.equal(h.card.children.length, 0);
});
test('battle visual: context switch cancels pending play; reduced motion keeps label with no smooth scroll', async t => {
    const old = globalThis.matchMedia; globalThis.matchMedia = () => ({ matches: true });
    t.after(() => { if (old === undefined) delete globalThis.matchMedia; else globalThis.matchMedia = old; });
    const h = dom(); h.root.connected = true;
    playBattleVisual(h.root, h.app); h.app.ctx = { chatMetadata: {} }; await flush(); assert.equal(h.card.children.length, 0);
    h.app.ctx = h.app.battleVisual.ctx; playBattleVisual(h.root, h.app); await flush();
    assert.equal(h.side.scrolled.behavior, 'auto'); assert.equal(h.card.children[0].style.animation, 'none');
    assert.ok(h.card.children[0].children[0].textContent.includes('大成功'));
    for (const fn of [...h.card.handlers.animationend]) fn({ target: h.card, elapsedTime: 1.2 });
});
