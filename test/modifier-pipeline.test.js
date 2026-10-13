import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { Rng } from '../src/core/rng.js';
import { GENERIC_D20 } from '../src/core/ruleset.js';
import { normalizeCombatant, normalizeSkill, normalizeStatus, parseExplicitModifiers } from '../src/core/schema.js';
import { buildScope, effectiveStats, rollHit } from '../src/combat/engine.js';
import { estimatePower, parseAdvantage, parsePipeSkill, parseSkillBlock, parseSkillLine } from '../src/llm/skill-parse.js';
import { parseSituationReport } from '../src/llm/report-parser.js';

function fighter(name = '甲', extra = {}) {
    return normalizeCombatant({
        name, side: 'ally', attributeBasis: 'base',
        attributes: { HP: 100, MP: 100, Atk: 20, Armor: 5, Speed: 10, Evasion: 10 },
        ...extra,
    });
}

class TenRng extends Rng {
    next() { this.calls++; return 0.45; }
}

const report = (equipmentField, temporaryField) => `
## 参战双方
### 我方
**异乡客**（自由设定）
- 位阶：凡人
- 血量：100%
- 魔量：100%
- 武器与装备：${equipmentField}
- 临时加成/减益：${temporaryField}
- 技能：
  - 射击｜伤害｜100｜0｜对单体攻击，判定+3
### 敌方
**陌生对手**（自由设定）
- 位阶：凡人
- 血量：100%
- 魔量：100%
- 技能：
  - 反击｜伤害｜100｜0｜单体攻击
`;

function parseActor(equipment, status) {
    const parsed = parseSituationReport(report(equipment, status));
    assert.equal(parsed.ok, true, parsed.error);
    return normalizeCombatant(parsed.system.combatants.find((unit) => unit.name === '异乡客'));
}

describe('明确加值从原文到实际判定', () => {
    it('判定+20映射为默认骰面+20，威力不因判定加值增加', () => {
        const plain = parseSkillLine('斩击：单体攻击');
        const improved = parseSkillLine('斩击：单体攻击，判定优势+20');
        const piped = parsePipeSkill('斩击｜伤害｜120｜0｜单体攻击，判定+20');
        assert.equal(improved.aim, 300);
        assert.equal(piped.aim, 300);
        assert.equal(improved.power, plain.power);
        assert.equal(estimatePower('一流', 20), estimatePower('一流', 0));
        const rng = new TenRng(1);
        const result = rollHit(rng, fighter(), fighter('乙', { side: 'enemy' }), normalizeSkill(piped), GENERIC_D20);
        assert.equal(result.nat, 10);
        assert.equal(result.total, 30);
        assert.equal(rng.calls, 1);
    });

    it('无关数字、百分比、定性优势不被当作技能判定加值', () => {
        for (const text of ['减伤+20%', '速度+8', '年龄+20', '持续3回合', '拥有绝对优势', '判定+20 %']) {
            assert.equal(parseAdvantage(text).bonus, 0, text);
        }
        assert.equal(parseAdvantage('判定-2.5').bonus, -2.5);
        assert.equal(parseAdvantage('＋4 判定优势').bonus, 4);
        assert.deepEqual(parseExplicitModifiers('攻击+20 %，护甲+10%，速度-2，等级+5'), [{ attr: 'Speed', delta: -2 }]);
    });

    it('增减益的目标命中与本次施放判定各自归属，不重复加值', () => {
        const debuff = parsePipeSkill('干扰｜减益｜0｜0｜目标命中-2');
        assert.equal(debuff.aim, 100);
        assert.deepEqual(debuff.effects[0].modifiers, [{ attr: 'hit', delta: -2 }]);
        const cast = parsePipeSkill('干扰｜减益｜0｜0｜本次施放判定+3，目标命中-2');
        assert.equal(cast.aim, 130);
        assert.deepEqual(cast.effects[0].modifiers, [{ attr: 'hit', delta: -2 }]);
    });

    it('显式Aim:0和负值经过重复归一化仍保持原值，缺省才补100', () => {
        assert.equal(normalizeSkill('【失准】[攻击;power:30][Aim:0]').aim, 0);
        assert.equal(normalizeSkill(normalizeSkill({ name: '零', aim: 0 })).aim, 0);
        assert.equal(normalizeSkill({ name: '负', aim: -10 }).aim, -10);
        assert.equal(normalizeSkill('【普通】[攻击;power:30]').aim, 100);
    });

    it('状态与效果的结构化加值保留符号、元数据及显式空数组契约', () => {
        const skill = normalizeSkill({ name: '扰乱', effects: [{ type: 'debuff', power: 99, duration: 2, tag: '单盲', description: '原文命中-2', modifiers: [{ attr: '命中', delta: -2 }] }] });
        const effect = normalizeSkill(skill).effects[0];
        assert.equal(effect.tag, '单盲');
        assert.equal(effect.description, '原文命中-2');
        assert.deepEqual(effect.modifiers, [{ attr: 'hit', delta: -2 }]);
        const status = normalizeStatus({ name: '乱流', ...effect });
        assert.equal(status.tag, '单盲');
        assert.deepEqual(status.modifiers, effect.modifiers);
        assert.equal(effectiveStats(fighter('甲', { statuses: [status] })).hit, -2);
        const legacy = normalizeStatus({ name: '精准', type: 'buff', power: 3 });
        assert.equal(Object.hasOwn(legacy, 'modifiers'), false);
        assert.equal(effectiveStats(fighter('甲', { statuses: [legacy] })).hit, 3);
        const explicitEmpty = normalizeStatus({ name: '精准', type: 'buff', power: 3, modifiers: [] });
        assert.deepEqual(explicitEmpty.modifiers, []);
        assert.equal(effectiveStats(fighter('甲', { statuses: [explicitEmpty] })).hit, 0);
    });

    it('一个管道技能内的分号保留多属性，不分裂成额外技能', () => {
        const skills = parseSkillBlock(['强化｜增益｜0｜0｜自身攻击+5;护甲+2']);
        assert.equal(skills.length, 1);
        assert.deepEqual(skills[0].effects[0].modifiers, [{ attr: 'Atk', delta: 5 }, { attr: 'Armor', delta: 2 }]);
    });

    for (const multiline of [false, true]) {
        it(`汇报${multiline ? '子列表' : '单行'}的多装备和临时状态进入计算，来源和总值相等`, () => {
            const equipment = multiline ? '\n  - 聚焦器（Atk+5，命中+1）\n  - 轻靴（Speed+2）' : '聚焦器（Atk+5，命中+1）、轻靴（Speed+2）';
            const status = multiline ? '\n  - 专注（命中+2，持续3回合）\n  - 负担（攻击-3，速度-1）' : '专注（命中+2，持续3回合）、负担（攻击-3，速度-1）';
            const actor = parseActor(equipment, status);
            assert.equal(actor.attributeBasis, 'base');
            assert.equal(actor.equipment.length, 2);
            assert.equal(actor.statuses.length, 2);
            assert.equal(actor.statuses.find((item) => item.name === '专注').duration, 3);
            const stats = effectiveStats(actor);
            assert.equal(stats.Atk, actor.attributes.Atk.current + 5 - 3);
            assert.equal(stats.Speed, actor.attributes.Speed.current + 2 - 1);
            assert.equal(stats.hit, 3);
            const scope = buildScope({ attacker: actor, defender: fighter('乙'), skill: actor.skills[0] });
            assert.equal(scope.Atk, stats.Atk);
            assert.equal(scope.hitBonus, 3);
            const hit = rollHit(new TenRng(1), actor, fighter('乙'), actor.skills[0], GENERIC_D20);
            assert.equal(hit.total, 16);
            assert.equal(hit.nat + hit.modifiers.reduce((sum, part) => sum + part.value, 0), hit.total);
            assert.ok(hit.modifiers.some((part) => part.source.includes('聚焦器')));
            assert.ok(hit.modifiers.some((part) => part.source.includes('专注')));
        });
    }

    it('定性或百分比只保留原文，不从职业/人设猜测平加数字', () => {
        const actor = parseActor('神秘装置（削减伤害20%）', '洞悉战场；速度大幅提升；减伤+20%');
        assert.deepEqual(actor.equipment[0].bonuses, {});
        assert.deepEqual(actor.statuses, []);
        assert.match(actor.notes, /洞悉战场/);
        assert.match(actor.notes, /20%/);
        assert.equal(effectiveStats(actor).hit, 0);
    });

    it('旧卡属性口径未知时不加装备；明确base加一次，effective可保留', () => {
        const data = { name: '甲', attributes: { HP: 100, Atk: 20 }, equipment: [{ name: '工具', bonuses: { Atk: 5 } }] };
        const legacy = normalizeCombatant(data);
        assert.equal(legacy.attributeBasis, 'unspecified');
        assert.equal(effectiveStats(legacy).Atk, 20);
        const base = normalizeCombatant({ ...data, attributeBasis: 'base' });
        assert.equal(effectiveStats(normalizeCombatant(base)).Atk, 25);
        const effective = normalizeCombatant({ ...data, attributeBasis: 'effective' });
        assert.equal(effective.attributeBasis, 'effective');
        assert.equal(effectiveStats(effective).Atk, 20);
    });
});
