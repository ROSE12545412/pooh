import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { AppController } from '../src/app.js';
import { applyLoadout, createLoadoutEntry, saveRefinedLoadout, selectedLoadoutEntries, loadoutSceneNote } from '../src/core/loadout.js';
import { normalizePowerSystem } from '../src/core/schema.js';
import { effectiveStats } from '../src/combat/engine.js';
import { EXT_ID } from '../src/config.js';
function entry(id, kind, name = id, enabled = true) {
    const draft = createLoadoutEntry({ id, kind, name, description: '可执行装备或技能', enabled });
    const rule = kind === 'skill' ? { name, description: '直接伤害', target: 'single', power: 5, aim: 100, cost: 0, cooldown: 0, effects: [{ type: 'damage', power: 5, duration: 0 }] }
        : { name, description: '攻击加值', slot: kind, bonuses: { Atk: 2 }, checks: { attack: 'normal', defense: 'normal' } };
    return saveRefinedLoadout([draft], { id, revision: draft.revision, rule }).entries[0];
}
function system() {
    return normalizePowerSystem({ combatants: [{ id: 'p', name: '玩家', isUser: true, side: 'ally', attributeBasis: 'effective', attributes: { HP: 100, Atk: 20 }, equipment: [
        { id: 'old1', name: '剧情戒指', slot: 'accessory', bonuses: { Atk: 3 } },
        { id: 'old2', name: '剧情项链', slot: 'accessory', bonuses: { Atk: 4 } },
        { id: 'sword', name: '剧情剑', slot: 'weapon', bonuses: { Atk: 2 } },
    ] }, { id: 'e', name: '敌方', side: 'enemy', attributes: { HP: 100 } }] });
}
function appFixture() {
    const ctx = { name1: '玩家', chat: [], chatMetadata: {}, extensionSettings: {}, saveSettingsDebounced() {}, async saveMetadata() {} };
    const app = new AppController(ctx);
    ctx.chatMetadata['tavern-dice'] = app.data;
    app.data.powerSystem = system();
    app.settings.loadout.entries = [entry('s1', 'skill', '技能一', false), entry('s2', 'skill', '技能二', false), entry('w1', 'weapon', '武器一', false), entry('w2', 'weapon', '武器二', false), entry('a1', 'accessory', '饰品一', false), entry('a2', 'accessory', '饰品二', false), entry('a3', 'accessory', '饰品三', false), entry('same', 'accessory', '饰品一', false), createLoadoutEntry({ id: 'draft', name: '未润色', kind: 'skill' })];
    return app;
}
describe('战前技能与装备选择', () => {
    it('保留两件不同名饰品，异常旧数据最多保留最后两件，同名不叠加', () => {
        assert.equal(selectedLoadoutEntries([entry('a', 'accessory'), entry('b', 'accessory')]).length, 2);
        assert.deepEqual(selectedLoadoutEntries([entry('a', 'accessory'), entry('b', 'accessory'), entry('c', 'accessory')]).map(e => e.id), ['b', 'c']);
        assert.deepEqual(selectedLoadoutEntries([entry('a', 'accessory', '同名'), entry('b', 'accessory', '同名')]).map(e => e.id), ['b']);
    });
    it('custom替换全部剧情饰品并应用两件加值，重放及none可逆幂等', () => {
        const raw = system(), entries = [entry('a', 'accessory'), entry('b', 'accessory')];
        const custom = applyLoadout(raw, entries, { accessoryMode: 'custom' });
        const p = custom.combatants[0];
        assert.deepEqual(p.equipment.map(e => e.name), ['剧情剑', 'a', 'b']);
        assert.equal(effectiveStats(p).Atk, 17);
        assert.deepEqual(applyLoadout(custom, entries, { accessoryMode: 'custom' }), custom);
        const none = applyLoadout(custom, entries, { accessoryMode: 'none' });
        assert.equal(effectiveStats(none.combatants[0]).Atk, 13);
        assert.deepEqual(none.combatants[0].equipment.map(e => e.name), ['剧情剑']);
        assert.deepEqual(applyLoadout(none, entries, { accessoryMode: 'none' }), none);
        assert.deepEqual(applyLoadout(none, [], { accessoryMode: 'story' }), raw);
    });
    it('story以及空custom不会覆盖正文，none无需勾选装备也能移除', () => {
        const raw = system();
        assert.deepEqual(applyLoadout(raw, [entry('a', 'accessory')], { accessoryMode: 'story' }), raw);
        assert.deepEqual(applyLoadout(raw, [], { accessoryMode: 'custom' }), raw);
        assert.equal(applyLoadout(raw, [], { accessoryMode: 'none' }).combatants[0].equipment.length, 1);
        assert.match(loadoutSceneNote([], { accessoryMode: 'none' }), /不佩戴饰品/);
        assert.match(loadoutSceneNote([entry('a', 'accessory'), entry('b', 'accessory')], { accessoryMode: 'custom' }), /两个饰品可以同时佩戴/);
    });
    it('技能多选全选，未润色拒绝，武器单选互斥及null回退', async () => {
        const app = appFixture();
        assert.equal(app.prebattleSelection.accessoryMode, 'story');
        assert.equal((await app.setPrebattleSelection('skill', ['s1', 's2'])).ok, true);
        assert.deepEqual(app.prebattleSelection.skills, ['s1', 's2']);
        assert.equal((await app.setPrebattleSelection('skill', ['draft'])).ok, false);
        assert.equal((await app.setPrebattleSelection('weapon', 'w1')).ok, true);
        assert.equal((await app.setLoadoutEnabled('w2', true)).ok, true);
        assert.equal(app.prebattleSelection.weapon, 'w2');
        assert.equal(app.loadoutEntries.find(e => e.id === 'w1').enabled, false);
        await app.setPrebattleSelection('weapon', null);
        assert.equal(app.prebattleSelection.weapon, null);
    });
    it('饰品两件上限、同名拒绝、旧携带入口一致，空为none而story回退', async () => {
        const app = appFixture();
        assert.equal((await app.setPrebattleSelection('accessory', ['a1', 'a2'])).ok, true);
        assert.deepEqual(app.prebattleSelection.accessories, ['a1', 'a2']);
        assert.equal(app.settings.loadout.accessoryMode, 'custom');
        assert.equal((await app.setLoadoutEnabled('a3', true)).ok, false);
        assert.equal((await app.setPrebattleSelection('accessory', ['a1', 'same'])).ok, false);
        assert.deepEqual(app.prebattleSelection.accessories, ['a1', 'a2']);
        await app.setPrebattleSelection('accessory', []);
        assert.equal(app.prebattleSelection.accessoryMode, 'none');
        await app.setPrebattleSelection('accessoryMode', 'story');
        assert.equal(app.prebattleSelection.accessoryMode, 'story');
        assert.deepEqual(app.prebattleSelection.accessories, []);
    });
    it('旧设置缺模式时迁移已携带有效饰品，显式story不被覆盖', () => {
        const selected = entry('legacy', 'accessory');
        const ctx = { extensionSettings: { [EXT_ID]: { loadout: { entries: [selected] } } }, chatMetadata: {} };
        const app = new AppController(ctx);
        assert.equal(app.prebattleSelection.accessoryMode, 'custom');
        assert.deepEqual(app.prebattleSelection.accessories, ['legacy']);
        ctx.extensionSettings[EXT_ID].loadout.accessoryMode = 'story';
        assert.equal(app.prebattleSelection.accessoryMode, 'story');
    });
    it('真实开战装载两件饰品，none撤掉正文加值，story恢复正文', async () => {
        const app = appFixture();
        await app.setPrebattleSelection('accessory', ['a1', 'a2']);
        assert.equal((await app.startBattle({ seed: 'dual' })).ok, true);
        assert.equal(effectiveStats(app.battle.units.find(u => u.isUser)).Atk, 17);
        assert.equal(app.battle.units.find(u => u.isUser).equipment.filter(e => e.slot === 'accessory').length, 2);
        await app.setPrebattleSelection('accessory', []);
        assert.equal((await app.startBattle({ seed: 'none' })).ok, true);
        assert.equal(effectiveStats(app.battle.units.find(u => u.isUser)).Atk, 13);
        await app.setPrebattleSelection('accessoryMode', 'story');
        assert.equal((await app.startBattle({ seed: 'story' })).ok, true);
        assert.equal(effectiveStats(app.battle.units.find(u => u.isUser)).Atk, 20);
    });
    it('选择只影响下一场，设置保存失败明确返回失败', async () => {
        const app = appFixture();
        await app.startBattle({ seed: 'selection' });
        const snapshot = structuredClone(app.battle.toState());
        await app.setPrebattleSelection('accessory', ['a1', 'a2']);
        assert.deepEqual(app.battle.toState(), snapshot);
        app.persistSettings = async () => false;
        assert.equal((await app.setPrebattleSelection('weapon', 'w1')).ok, false);
    });
});
