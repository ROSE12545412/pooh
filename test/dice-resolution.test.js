import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { Rng } from '../src/core/rng.js';
import { GENERIC_D20, compileFormula, normalizeRuleset, resolvePower } from '../src/core/ruleset.js';
import { normalizeCombatant, normalizeSkill } from '../src/core/schema.js';
import { Battle, OUTCOME, buildScope, effectiveStats, rollDamage, rollEffectValue, rollHit } from '../src/combat/engine.js';

class SequenceRng extends Rng {
    constructor(...values) {
        super(1);
        this.values = values;
    }
    next() {
        assert.ok(this.values.length, '不能为了明细或天然判定额外掷骰');
        this.calls++;
        return this.values.shift();
    }
}

function unit(overrides = {}) {
    return normalizeCombatant({
        id: 'actor', name: '行动者', side: 'ally', attributeBasis: 'base',
        attributes: { HP: { current: 1000, max: 1000 }, MP: { current: 100, max: 100 }, Atk: { current: 20, max: 20 }, Armor: 5, Speed: 10, Evasion: 10 },
        statuses: [], equipment: [], ...overrides,
    });
}
const skill = { name: '斩击', aim: 100, power: 30 };
const noSpecial = { ...GENERIC_D20, critFormula: '0', fumbleFormula: '0' };
const enemy = () => unit({ id: 'target', name: '目标', side: 'enemy' });

function hit(rng, ruleset = GENERIC_D20, attacker = unit(), defender = enemy(), move = skill) {
    return rollHit(rng, attacker, defender, move, ruleset);
}

describe('真实判定与随机数追踪回归', () => {
    it('通用命中只掷一颗骰，天然值、总值、明细共享它', () => {
        const rng = new SequenceRng(0.45);
        const result = hit(rng);
        assert.equal(result.nat, 10);
        assert.equal(result.total, 10);
        assert.equal(result.target, 10);
        assert.equal(result.outcome, OUTCOME.HIT);
        assert.equal(result.naturalSource, '命中骰');
        assert.deepEqual(result.dice.map((die) => die.rolls), [[10]]);
        assert.equal(rng.calls, 1);
        assert.equal(result.actorName, '行动者');
        assert.equal(result.actorSide, 'ally');
        assert.equal(result.targetName, '目标');
        assert.equal(result.targetSide, 'enemy');
        assert.equal(result.skillName, '斩击');
        const calls = rng.calls;
        JSON.stringify(result);
        assert.equal(rng.calls, calls);
    });

    it('天然20/1覆盖普通比较，但仍来自同颗骰', () => {
        const critical = hit(new SequenceRng(0.95), { ...GENERIC_D20, hitTargetFormula: '100' });
        assert.equal(critical.total, 20);
        assert.equal(critical.baseOutcome, OUTCOME.MISS);
        assert.equal(critical.override, OUTCOME.CRIT);
        assert.match(critical.specialRule, /nat == 20/);
        const fumble = hit(new SequenceRng(0), { ...GENERIC_D20, hitTargetFormula: '0' });
        assert.equal(fumble.total, 1);
        assert.equal(fumble.override, OUTCOME.FUMBLE);
    });

    it('技能小数、装备和状态只加一次，来源总和与total一致', () => {
        const attacker = unit({
            equipment: [{ name: '准星', bonuses: { hit: 2 } }],
            statuses: [{ name: '精准', type: 'buff', power: 99, duration: 3, stacks: 2, modifiers: [{ attr: 'hit', delta: 1.25 }] }],
        });
        const result = hit(new SequenceRng(0.45), GENERIC_D20, attacker, enemy(), { ...skill, aim: 105 });
        assert.equal(result.total, 15);
        assert.equal(result.scope.hitBonus, 4.5);
        assert.deepEqual(result.modifiers.map((part) => part.value), [0.5, 2, 2.5]);
        assert.equal(result.nat + result.modifiers.reduce((sum, part) => sum + part.value, 0), result.total);
        assert.ok(result.modifiers.some((part) => part.source.includes('准星')));
        assert.equal(result.variables.hitBonus, 4.5);
    });

    it('目标使用真实闪避及下限调整，不伪造护甲目标', () => {
        const defender = enemy();
        defender.statuses = [{ name: '减闪避', type: 'debuff', power: 30, stacks: 1 }];
        const result = hit(new SequenceRng(0.45), noSpecial, unit(), defender);
        assert.equal(result.target, 1);
        assert.deepEqual(result.targetModifiers.map((part) => part.value), [10, -30, 21]);
        assert.equal(result.targetModifiers.reduce((sum, part) => sum + part.value, 0), result.target);
    });

    it('只升级旧通用预设的默认式，不改相同形状的自定义规则', () => {
        const oldFormula = 'd20 + (Aim - 100) / 10';
        assert.equal(normalizeRuleset({ ...GENERIC_D20, hitFormula: oldFormula }).hitFormula, GENERIC_D20.hitFormula);
        assert.equal(normalizeRuleset({ ...GENERIC_D20, id: 'custom-card', hitFormula: oldFormula }).hitFormula, oldFormula);
        assert.equal(normalizeRuleset({ ...GENERIC_D20, hitFormula: 'd20 + Atk' }).hitFormula, 'd20 + Atk');
    });

    it('任意单骰公式复用天然值，非默认公式不伪称total-nat为属性加值', () => {
        const result = hit(new SequenceRng(0.45), { ...noSpecial, id: 'custom', hitFormula: '(d20 + Atk) * 2', hitTargetFormula: 'Armor + Speed' });
        assert.equal(result.total, 60);
        assert.equal(result.target, 15);
        assert.equal(result.modifiers, null);
        assert.equal(result.targetModifiers, null);
        assert.deepEqual(result.variables, { Atk: 20, Armor: 5, Speed: 10 });
    });

    it('2d6和两个独立d20保留原自定义语义及独立天然骰', () => {
        const rng = new SequenceRng(0.4, 0, 0.99);
        const result = hit(rng, { ...noSpecial, id: '2d6', hitFormula: '2d6 + 3' });
        assert.equal(result.nat, 3);
        assert.equal(result.total, 10);
        assert.equal(result.naturalSource, '独立天然骰');
        assert.deepEqual(result.dice.map((die) => die.rolls), [[1, 6]]);
        assert.equal(result.modifiers, null);
        assert.equal(rng.calls, 3);
        const max = hit(new SequenceRng(0.45, 0, 0.95), { ...noSpecial, hitFormula: 'max(d20, d20)' });
        assert.equal(max.total, 20);
        assert.equal(max.nat, 10);
        assert.deepEqual(max.dice.map((die) => die.rolls), [[1], [20]]);
        assert.equal(max.naturalSource, '独立天然骰');
    });

    it('目标骰和天然特殊公式骰各有明细，不重用命中骰', () => {
        const rng = new SequenceRng(0.45, 0.2, 0.9);
        const result = hit(rng, { ...GENERIC_D20, hitFormula: 'd20', hitTargetFormula: 'd20', critFormula: 'd6 == 6' });
        assert.equal(result.nat, 10);
        assert.equal(result.total, 10);
        assert.equal(result.target, 5);
        assert.deepEqual(result.targetDice.map((die) => die.rolls), [[5]]);
        assert.deepEqual(result.specialDice.map((die) => die.rolls), [[6]]);
        assert.equal(result.override, OUTCOME.CRIT);
        assert.equal(rng.calls, 3);
    });

    it('短路和三元未执行分支不掷骰，复合判定不回落默认', () => {
        const rng = new SequenceRng();
        const scope = { __rng: rng, nat: 20, Aim: 0 };
        assert.equal(compileFormula('0 && d20')(scope), 0);
        assert.equal(compileFormula('1 || d20')(scope), 1);
        assert.equal(compileFormula('0 ? d20 : 7')(scope), 7);
        assert.equal(compileFormula('nat == 20 && Aim > 0')(scope), 0);
        assert.equal(compileFormula('nat == 20 || nat == 19')(scope), 1);
        assert.equal(rng.calls, 0);
        const result = hit(new SequenceRng(0.45), { ...noSpecial, hitFormula: '0 ? d20 : 7' });
        assert.equal(result.total, 7);
        assert.deepEqual(result.dice, []);
        assert.equal(result.naturalSource, '独立天然骰');
    });

    it('概率模式保留原始精度、严格小于及独立天然覆盖', () => {
        const ruleset = { ...noSpecial, hitMode: 'chance', hitChanceFormula: '0.49955' };
        const result = hit(new SequenceRng(0.5, 0.49954), ruleset);
        assert.equal(result.total, 0.49954);
        assert.equal(result.target, 0.49955);
        assert.equal(result.outcome, OUTCOME.HIT);
        assert.equal(result.comparison, '<');
        assert.equal(result.naturalSource, '独立天然骰');
        assert.equal(result.modifiers, null);
        assert.equal(hit(new SequenceRng(0.5, 0.49955), ruleset).outcome, OUTCOME.MISS);
        const crit = hit(new SequenceRng(0.95, 0.4), { ...GENERIC_D20, hitMode: 'chance', hitChanceFormula: '0' });
        assert.equal(crit.baseOutcome, OUTCOME.MISS);
        assert.equal(crit.override, OUTCOME.CRIT);
        const fumble = hit(new SequenceRng(0, 0.4), { ...GENERIC_D20, hitMode: 'chance', hitChanceFormula: '1' });
        assert.equal(fumble.override, OUTCOME.FUMBLE);
    });

    it('d100对抗仍按高值达标；多骰除法不会误判为概率公式', () => {
        const result = hit(new SequenceRng(0.99), { ...noSpecial, hitFormula: 'd100', hitTargetFormula: '70' });
        assert.equal(result.total, 100);
        assert.equal(result.nat, 100);
        assert.equal(result.outcome, OUTCOME.HIT);
        assert.equal(normalizeRuleset({ hitFormula: '2d6 / 12' }).hitMode, 'dice');
    });

    it('rand/randint实际值进trace，展示与序列化不会重新求值', () => {
        const rng = new SequenceRng(0.45, 0.25, 0.9);
        const result = hit(rng, { ...noSpecial, hitFormula: 'd20 + rand(0, 2) + randint(1, 6)' });
        assert.equal(result.total, 16.5);
        assert.deepEqual(result.random.map(({ kind, value }) => ({ kind, value })), [{ kind: 'rand', value: 0.5 }, { kind: 'randint', value: 6 }]);
        assert.equal(rng.calls, 3);
        JSON.parse(JSON.stringify(result));
        assert.equal(rng.calls, 3);
    });

    it('两条特殊公式同时成立仍然暴击优先', () => {
        const result = hit(new SequenceRng(0.45), { ...GENERIC_D20, critFormula: '1', fumbleFormula: '1' });
        assert.equal(result.outcome, OUTCOME.CRIT);
    });
});

describe('属性、效果与伤害来源回归', () => {
    it('装备只对明确base属性叠加，unspecified说明口径', () => {
        const equipment = [{ name: '长剑', bonuses: { Atk: 4, Armor: 2, Speed: 3, Evasion: 1, hit: 2 } }];
        const base = unit({ equipment });
        const stats = effectiveStats(base);
        assert.deepEqual([stats.Atk, stats.Armor, stats.Speed, stats.Evasion, stats.hit], [24, 7, 13, 11, 2]);
        const old = unit({ equipment, attributeBasis: 'unspecified' });
        assert.equal(effectiveStats(old).Atk, 20);
        assert.equal(effectiveStats(old).hit, 0);
        const result = hit(new SequenceRng(0.45), GENERIC_D20, old);
        assert.equal(result.notes.length, 1);
        assert.match(result.notes[0], /未额外叠加装备/);
    });

    it('显式修正使用signed delta乘层数，关键词与控制不重复叠加', () => {
        const attacker = unit({ statuses: [{ name: '定身攻击强化', description: '攻击命中', type: 'debuff', power: -99, duration: 3, stacks: 2, modifiers: [{ attr: 'Atk', delta: -2 }, { attr: 'hit', delta: 1.5 }] }] });
        const stats = effectiveStats(attacker);
        assert.equal(stats.Atk, 16);
        assert.equal(stats.hit, 3);
        assert.equal(stats.Evasion, 10);
        assert.equal(stats.parts.length, 2);
    });

    it('legacy负power减益不会反向增益，防御强化不会误加攻击', () => {
        const stats = effectiveStats(unit({ statuses: [
            { name: '致盲', type: 'debuff', power: -5, stacks: 1, duration: 3 },
            { name: '防御强化', type: 'buff', power: 4, stacks: 1, duration: 3 },
        ] }));
        assert.equal(stats.hit, -5);
        assert.equal(stats.Armor, 9);
        assert.equal(stats.Atk, 20);
    });

    it('缺省modifiers保留旧规则，显式空数组关闭关键词推断', () => {
        const status = { name: '命中攻击强化', type: 'buff', power: 5, stacks: 1, duration: 3 };
        const legacy = unit({ statuses: [status] });
        assert.equal(Object.hasOwn(legacy.statuses[0], 'modifiers'), false);
        assert.equal(effectiveStats(legacy).Atk, 25);
        assert.equal(effectiveStats(legacy).hit, 5);
        const explicitEmpty = unit({ statuses: [{ ...status, modifiers: [] }] });
        assert.deepEqual(explicitEmpty.statuses[0].modifiers, []);
        assert.equal(effectiveStats(explicitEmpty).Atk, 20);
        assert.equal(effectiveStats(explicitEmpty).hit, 0);
    });

    it('显式aim0不被当作缺省100', () => {
        const move = normalizeSkill({ name: '无法瞄准', aim: 0, power: 10 });
        assert.equal(move.aim, 0);
        assert.equal(buildScope({ attacker: unit(), defender: enemy(), skill: move }).Aim, 0);
        const result = hit(new SequenceRng(0.5, 0.1), { ...noSpecial, hitMode: 'chance', hitChanceFormula: 'Aim / (Speed + Aim)' }, unit(), enemy(), move);
        assert.equal(result.target, 0);
        assert.equal(result.outcome, OUTCOME.MISS);
    });

    it('Atk比例伤害及效果用当前有效攻击力，MaxHP比例仍按上限', () => {
        const attacker = unit({ equipment: [{ name: '剑', bonuses: { Atk: 5 } }], statuses: [{ name: '攻击强化', type: 'buff', power: 10, stacks: 1, duration: 3 }] });
        const ruleset = { ...GENERIC_D20, powerMode: 'ratio-atk', damageFormula: 'power' };
        const damage = rollDamage(new SequenceRng(), attacker, enemy(), { ...skill, power: 50 }, { outcome: 'hit', nat: 10 }, ruleset);
        assert.equal(damage.power, 17.5);
        assert.equal(damage.damage, 17);
        assert.equal(damage.powerBase, 'ATK(35)');
        assert.equal(rollEffectValue(new SequenceRng(), attacker, enemy(), skill, 'buff', 50, ruleset).value, 17);
        assert.equal(resolvePower(10, 'ratio-maxhp', attacker).value, 100);
        const depleted = unit();
        depleted.attributes.Atk.current = 0;
        assert.equal(resolvePower(50, 'ratio-atk', depleted).value, 0);
    });

    it('普通攻击读取有效攻击力并把真实命中快照写入日志', () => {
        const attacker = unit({ statuses: [{ name: '攻击强化', type: 'buff', power: 10, stacks: 1, duration: 9 }] });
        const battle = new Battle({ combatants: [attacker, enemy()] }, { seed: 'basic-power', ruleset: { ...noSpecial, damageFormula: 'power' } });
        battle.start();
        battle.initiative = [{ unitId: attacker.id }, { unitId: 'target' }];
        battle.turnIndex = 0;
        battle.rng = new SequenceRng(0.45);
        assert.equal(battle.act({ unitId: attacker.id, action: 'attack', targetIds: ['target'] }).ok, true);
        const attack = battle.log.find((entry) => entry.data?.hit);
        assert.equal(attack.data.damage.power, 30);
        assert.equal(attack.data.hit.actorName, attacker.name);
        assert.equal(attack.data.hit.targetName, '目标');
    });

    it('effect power0和修正/描述跨技能→状态保留，不回退skill.power', () => {
        const move = normalizeSkill({ name: '精准架势', target: 'self', power: 40, effects: [{ type: 'buff', power: 0, duration: 4, tag: '命中', description: '稳定瞄准', modifiers: [{ attr: 'hit', delta: 3 }] }] });
        const battle = new Battle({ combatants: [unit(), enemy()] }, { seed: 'effect' });
        const actor = battle.units[0];
        battle._resolveSkill(actor, move);
        const status = actor.statuses.find((entry) => entry.name === move.name);
        assert.equal(status.power, 0);
        assert.equal(status.description, '稳定瞄准');
        assert.equal(status.tag, '命中');
        assert.deepEqual(status.modifiers, [{ attr: 'hit', delta: 3 }]);
        assert.equal(effectiveStats(actor).hit, 3);
    });

    it('保持原伤害公式的暴击、护甲、最低伤害与未命中规则', () => {
        const normal = rollDamage(new SequenceRng(0), unit(), enemy(), skill, { outcome: 'hit', nat: 10 }, GENERIC_D20);
        const crit = rollDamage(new SequenceRng(0), unit(), enemy(), skill, { outcome: 'crit', nat: 20 }, GENERIC_D20);
        const miss = rollDamage(new SequenceRng(0), unit(), enemy(), skill, { outcome: 'miss', nat: 10 }, GENERIC_D20);
        assert.equal(normal.damage, 26);
        assert.equal(crit.damage, 57);
        assert.equal(miss.damage, 0);
    });
});
