import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { Battle, applyDamage, applyHeal } from '../src/combat/engine.js';
import { normalizeCombatant } from '../src/core/schema.js';
import { GENERIC_D20 } from '../src/core/ruleset.js';
const unit = (id, side, extra = {}) => ({ id, name: id, side, attributes: { HP: 10, MP: 20, Atk: 100, Armor: 0, Speed: 10, Evasion: 1 }, skills: [{ id: 'kill', name: 'kill', target: 'single', power: 100, cost: 3, cooldown: 2, effects: [{ type: 'damage' }] }], ...extra });
function fixture({ actor = 'player', mode = 'deadly', rules = {}, enemies = 1 } = {}) {
    const battle = new Battle({ combatants: [unit('player', 'ally', { isUser: true }), unit('friend', 'ally'), ...Array.from({ length: enemies }, (_, i) => unit('enemy' + i, 'enemy'))] }, { seed: 1, combatMode: mode, ruleset: { ...GENERIC_D20, hitFormula: '20', hitTargetFormula: '1', critFormula: '0', fumbleFormula: '0', damageFormula: '100', ...rules } });
    battle.start(); battle.initiative = [{ unitId: actor }, ...battle.units.filter(u => u.id !== actor).map(u => ({ unitId: u.id }))]; battle.turnIndex = 0;
    return battle;
}
const action = (extra = {}) => ({ skillId: 'kill', targetIds: ['enemy0'], ...extra });
describe('死斗留手与阻止', () => {
    it('预估只读、不消费随机数、资源、冷却，返回副本', () => {
        const b = fixture(); const before = b.toState(); const candidates = b.lethalCandidates(action());
        assert.equal(candidates.length, 1); candidates[0].name = 'changed'; assert.deepEqual(b.toState(), before);
        assert.equal(b.lethalCandidates(action({ targetIds: ['missing'] })).length, 0);
    });
    it('玩家致命命中留HP1退出观战且照常扣资源冷却，可恢复', () => {
        const b = fixture(); assert.equal(b.act(action({ mercyTargetIds: ['enemy0'] })).ok, true);
        const t = b.units.find(u => u.id === 'enemy0'); assert.equal(t.attributes.HP.current, 1); assert.equal(t.alive, false); assert.equal(t.incapacitated, true); assert.equal(t.side, 'neutral'); assert.equal(t.mercyWithdrawn, true);
        assert.equal(b.units[0].attributes.MP.current, 17); assert.ok(b.units[0].skills[0].cooldownLeft > 0);
        assert.ok(b.log.some(l => l.type === 'mercy' && l.data.success)); assert.ok(!b.log.some(l => l.text.includes('enemy0 倒下了（阵亡）')));
        const restored = Battle.fromState(b.toState()).units.find(u => u.id === t.id); assert.deepEqual(restored, t);
        assert.equal(applyDamage(t, 999).hpLost, 0); assert.equal(applyHeal(t, 'HP', 999).healed, 0); assert.equal(t.alive, false);
        const normalized = normalizeCombatant(t); assert.equal(normalized.mercyWithdrawn, true); assert.equal(normalized.alive, false);
    });
    it('未命中与非致命命中不退出，切磋不提示且忽略留手', () => {
        for (const rules of [{ hitFormula: '0' }, { damageFormula: '1' }]) {
            const b = fixture({ rules }); b.act(action({ mercyTargetIds: ['enemy0'] })); assert.equal(b.units[2].mercyWithdrawn, undefined); assert.equal(b.units[2].alive, true);
        }
        const b = fixture({ mode: 'spar' }); assert.deepEqual(b.lethalCandidates(action()), []); b.act(action({ mercyTargetIds: ['enemy0'] })); assert.equal(b.units[2].attributes.HP.current, 0); assert.equal(b.units[2].mercyWithdrawn, undefined);
    });
    it('队友阻止掷真实d20：成功退出，失败正常致命', () => {
        for (const nat of [20, 1]) {
            const b = fixture({ actor: 'friend' }); b.rng.d20 = () => { b.rng.calls++; return nat; };
            assert.equal(b.lethalCandidates(action()).length, 1); b.act(action({ interceptTargetIds: ['enemy0'] }));
            const t = b.units[2]; assert.equal(Boolean(t.mercyWithdrawn), nat === 20); assert.equal(t.attributes.HP.current, nat === 20 ? 1 : 0);
            const l = b.log.find(l => l.type === 'mercy'); assert.equal(l.data.nat, nat); assert.equal(l.data.success, nat === 20); assert.equal(l.data.dc, 10);
        }
    });
    it('不允许队友留手字段或玩家阻止字段越权，无玩家不询问', () => {
        const b = fixture({ actor: 'friend' }); b.act(action({ mercyTargetIds: ['enemy0'] })); assert.equal(b.units[2].attributes.HP.current, 0);
        const p = fixture(); p.act(action({ interceptTargetIds: ['enemy0'] })); assert.equal(p.units[2].attributes.HP.current, 0);
        const n = fixture({ actor: 'friend' }); n.units[0].isUser = false; assert.deepEqual(n.lethalCandidates(action()), []);
    });
    it('护盾纳入预估，群攻逐目标选择而不保护未选择目标', () => {
        const b = fixture({ enemies: 2 }); b.units[2].statuses = [{ name: 'shield', type: 'shield', power: 200, stacks: 1 }]; assert.deepEqual(b.lethalCandidates(action()), []);
        b.units[2].statuses = []; b.units[0].skills[0].target = 'group'; assert.equal(b.lethalCandidates({ skillId: 'kill' }).length, 2);
        b.act({ skillId: 'kill', mercyTargetIds: ['enemy0'] }); assert.equal(b.units[2].mercyWithdrawn, true); assert.equal(b.units[3].attributes.HP.current, 0);
    });
    it('任意骰公式非单调内部峰值可预估，复杂随机保守提示', () => {
        const b = fixture({ rules: { damageFormula: '100 - abs(d20 - 10) * 20' } }); assert.equal(b.lethalCandidates(action()).length, 1);
        const c = fixture({ rules: { damageFormula: 'rand(0,100)' } }); assert.equal(c.lethalCandidates(action())[0].uncertain, true);
    });
});
