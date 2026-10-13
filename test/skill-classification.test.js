import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { Rng } from '../src/core/rng.js';
import { GENERIC_D20 } from '../src/core/ruleset.js';
import { canonicalAttributeKey, normalizePowerSystem, normalizeSkill, normalizeStatus, parseExplicitModifiers } from '../src/core/schema.js';
import { Battle, aoeEffectivePower, effectiveStats, rollHit } from '../src/combat/engine.js';
import { parsePipeSkill, parseSkillBlock } from '../src/llm/skill-parse.js';
import { parseSituationReport } from '../src/llm/report-parser.js';
import { CHARM_REQUIREMENTS, DEFAULT_SCENE_PROMPT, SKILL_MECHANICS_REQUIREMENTS, buildSceneRequest } from '../src/llm/scene-prompt.js';
import { BATTLE_JSON_SCHEMA } from '../src/prompts/index.js';

class FaceRng extends Rng {
    constructor(face) { super('skill-classification'); this.face = face; }
    next() { this.calls++; return (this.face - 0.5) / 20; }
}

const actorName = '异乡来客';
const opponentNames = ['镜面来客', '石质来客'];
const actorSkills = [
    '停滞波｜群体(AOE)｜控制｜0｜4｜3｜14｜命中后附加停滞，回合豁免失败跳过当前行动',
    '侵蚀波｜群体(AOE)｜持续伤害+骰点减益｜18｜6｜4｜13｜命中后目标判定-2，本次施放判定+3',
    '折光击｜单体｜伤害+控制+持续伤害｜120｜8｜2｜12｜命中后附加控制；持续伤害=17',
    '自复｜自身｜治疗｜30｜2｜0｜-｜恢复自身状态',
];
const opponentSkills = [
    '撞击｜单体｜伤害｜30｜0｜0｜-｜一次冲击',
    '凝聚｜自身｜增益｜0｜0｜2｜-｜自身攻击+2',
    '稳定｜自身｜治疗｜10｜0｜0｜-｜恢复自身状态',
];
const detail = (name, skills, player = false) => `**${player ? '【玩家】' : ''}${name}**（异质实体）
- 位阶：中级
- 人设：谨慎守信，当前立场明确
- 对敌魅力：${player ? opponentNames[0] : actorName}｜${player ? 32 : 0}｜当前关系有据
- 血量：满状态
- 魔量：满状态
- 技能：
${skills.map((row) => `  - ${row}`).join('\n')}
- 武器与装备：赤手空拳
- 临时属性：无`;
const sceneReport = `# 战斗场景
## 参战人员名单
### 参战
**${actorName}**（异质实体）｜我方
${opponentNames.map((name) => `**${name}**（异质实体）｜敌方`).join('\n')}
### 观战
**旁观来客**（观察者）｜留在场外
## 参战双方
### 我方
${detail(actorName, actorSkills, true)}
### 敌方
${opponentNames.map((name) => detail(name, opponentSkills)).join('\n')}
## 战场环境
空旷场地
## 战斗模式
切磋
## 补充说明
只提供配置，命中与伤害由本地引擎结算。`;

function battleFromReport() {
    const parsed = parseSituationReport(sceneReport);
    assert.equal(parsed.ok, true, parsed.error);
    const system = normalizePowerSystem(parsed.system);
    return new Battle(system, { seed: 'new-eight-column', ruleset: { ...GENERIC_D20, powerMode: 'absolute' } });
}

const hasOwnDc = (effect) => Object.hasOwn(effect, 'saveDc');

describe('八列技能数据契约与五列兼容', () => {
    it('范围列优先于名字和描述，所有现有范围均可显式表达', () => {
        for (const [range, target] of [['单体', 'single'], ['群体(AOE)', 'group'], ['群体（AOE）', 'group'], ['自身', 'self'], ['全体', 'all'], ['随机', 'random']]) {
            const skill = parsePipeSkill(`全场波动｜${range}｜伤害｜80｜0｜0｜-｜名字虽像群体，实际按范围列`);
            assert.equal(skill.target, target, range);
            assert.equal(skill.power, 80);
            assert.equal(skill.effects[0].power, 80);
            assert.equal(hasOwnDc(skill.effects[0]), false);
        }
    });

    it('新格式纯负面技能保留0、时长和豁免，不附加即时伤害', () => {
        const control = normalizeSkill(parsePipeSkill('震慑爆发｜群体(AOE)｜控制｜0｜0｜4｜16｜命中后附加控制'));
        assert.equal(control.power, 0);
        assert.equal(control.cost, 0);
        assert.deepEqual(control.effects.map((effect) => effect.type), ['control']);
        assert.equal(control.effects[0].power, 0);
        assert.equal(control.effects[0].duration, 4);
        assert.equal(control.effects[0].saveDc, 16);
        const dot = normalizeSkill(parsePipeSkill('灼烧斩｜单体｜持续伤害｜37｜5｜3｜11｜命中后附加灼烧'));
        assert.deepEqual(dot.effects.map((effect) => effect.type), ['dot']);
        assert.equal(dot.effects[0].power, 37);
        assert.equal(dot.effects[0].duration, 3);
        assert.equal(dot.effects[0].saveDc, 11);
        const zero = parsePipeSkill('零伤害｜单体｜伤害｜0｜0｜0｜0｜仅保留零值');
        assert.equal(zero.effects[0].power, 0);
        assert.equal(zero.power, 0);
        const shield = parsePipeSkill('屏障｜自身｜护盾｜12｜0｜5｜-｜明确持续五个自身回合');
        assert.equal(shield.effects[0].power, 12);
        assert.equal(shield.effects[0].duration, 5);
    });

    it('复合效果全部保留，共享明确威力或读取每个效果的独立标签', () => {
        for (const dotPower of ['持续伤害=19', '持续伤害威力19', 'dot:19', '命中后持续伤害威力19']) {
            const skill = normalizeSkill(parsePipeSkill(`叠合｜单体｜伤害+控制+持续伤害+骰点减益｜120｜5｜3｜15｜伤害=95；${dotPower}；目标判定-2`));
            assert.deepEqual(skill.effects.map((effect) => effect.type), ['damage', 'control', 'dot', 'debuff']);
            assert.deepEqual(skill.effects.map((effect) => effect.power), [95, 0, 19, 0]);
            assert.deepEqual(skill.effects.map((effect) => effect.duration), [0, 3, 3, 3]);
            assert.equal(skill.power, 95);
            assert.equal(skill.effects[1].saveDc, 15);
            assert.equal(skill.effects[2].saveDc, 15);
            assert.equal(hasOwnDc(skill.effects[3]), false);
            assert.deepEqual(skill.effects[3].modifiers, [{ attr: 'hit', delta: -2 }]);
        }
        const shared = parsePipeSkill('叠合｜单体｜伤害+持续伤害｜21｜0｜2｜10｜两种效果均使用威力列');
        assert.deepEqual(shared.effects.map((effect) => effect.power), [21, 21]);
        const separated = parsePipeSkill('叠合｜单体｜伤害+持续伤害｜伤害=40；持续伤害=7｜0｜2｜10｜每种效果分别标值');
        assert.equal(separated.power, 40);
        assert.deepEqual(separated.effects.map((effect) => effect.power), [40, 7]);
    });

    it('旧五列表的数值与目标推断继续兼容，复合类型也不会被吞掉', () => {
        const old = parsePipeSkill('旧波｜持续伤害｜100｜7｜群体灼烧');
        assert.equal(old.target, 'group');
        assert.equal(old.power, 100);
        assert.equal(old.cost, 7);
        assert.equal(old.effects[0].power, 60);
        assert.equal(hasOwnDc(old.effects[0]), false);
        const mixed = parsePipeSkill('旧压制｜伤害+控制｜100｜5｜单体压制');
        assert.deepEqual(mixed.effects.map((effect) => effect.type), ['damage', 'control']);
        assert.ok(parsePipeSkill('旧单体|伤害|80|0|朴素冲击'));
    });

    it('新表不从未知数值和效果猜伤害；未知DC采用10，非豁免效果不带DC', () => {
        const unknown = parsePipeSkill('爆裂｜单体｜特殊｜未知｜0｜0｜-｜仅保留设定说明');
        assert.equal(unknown.power, 0);
        assert.deepEqual(unknown.effects.map((effect) => effect.type), ['other']);
        for (const dc of ['-', '0', '未知', 'Infinity', '31', '9.5']) {
            const skill = parsePipeSkill(`钳制｜单体｜控制+持续伤害｜20｜0｜2｜${dc}｜命中后生效`);
            assert.deepEqual(skill.effects.map((effect) => effect.saveDc), [10, 10]);
        }
        const debuff = parsePipeSkill('扰动｜单体｜骰点减益｜0｜0｜2｜20｜骰点-2');
        assert.equal(hasOwnDc(debuff.effects[0]), false);
    });

    it('所有有效技能都保留，分号只分隔同一技能的效果说明', () => {
        const rows = Array.from({ length: 13 }, (_, index) => `技能${index}｜单体｜伤害+持续伤害｜50｜0｜2｜10｜伤害=50；持续伤害=5`);
        const skills = parseSkillBlock(rows);
        assert.equal(skills.length, 13);
        assert.equal(skills[12].name, '技能12');
        assert.equal(skills[12].effects[1].power, 5);
        assert.equal(parseSkillBlock([...rows, rows[0]]).length, 13);
    });
});

describe('骰点减益与可选豁免的归一化', () => {
    it('目标判定与骰点均归入hit，施放者判定单独换算Aim', () => {
        for (const phrase of ['目标判定-2', '骰点-2', '命中-2']) {
            const skill = normalizeSkill(parsePipeSkill(`干扰｜单体｜骰点减益｜0｜0｜2｜-｜本次施放判定+3；${phrase}`));
            assert.equal(skill.aim, 130);
            assert.deepEqual(skill.effects[0].modifiers, [{ attr: 'hit', delta: -2 }]);
            assert.equal(skill.effects[0].description, `本次施放判定+3；${phrase}`);
        }
        const control = parsePipeSkill('冻结｜单体｜控制｜0｜0｜2｜10｜目标判定-2');
        assert.equal(control.aim, 100);
        assert.equal(canonicalAttributeKey('骰点'), 'hit');
        assert.equal(canonicalAttributeKey('目标判定'), 'hit');
        assert.deepEqual(parseExplicitModifiers('目标判定−2，骰点＋1'), [{ attr: 'hit', delta: -2 }, { attr: 'hit', delta: 1 }]);
    });

    it('缺少符号、百分比、定性说明不猜数值，施放判定不再重复进入目标状态', () => {
        for (const text of ['目标判定2', '骰点大幅降低', '骰点-20%', '判定-2.5 ％', '判定降低2', '本次施放判定+3', '本次施放命中判定+3']) {
            assert.deepEqual(parseExplicitModifiers(text), [], text);
        }
        const skill = parsePipeSkill('迟疑｜单体｜骰点减益｜0｜0｜2｜-｜目标判定降低，骰点-20%');
        assert.equal(skill.aim, 100);
        assert.deepEqual(skill.effects[0].modifiers, []);
    });

    it('重复归一化保留有效DC、描述、零值与修正；缺失或非法DC不伪造字段', () => {
        for (const type of ['control', 'dot']) {
            for (const saveDc of [2, 30, '17']) {
                const skill = normalizeSkill(normalizeSkill({ name: '约束', power: 0, effects: [{ type, power: 0, duration: 4, saveDc, description: '来源描述', modifiers: [{ attr: '骰点', delta: -2 }] }] }));
                const status = normalizeStatus(normalizeStatus({ name: '约束', ...skill.effects[0] }));
                assert.equal(skill.power, 0);
                assert.equal(status.saveDc, Number(saveDc));
                assert.equal(status.duration, 4);
                assert.equal(status.power, 0);
                assert.equal(status.description, '来源描述');
                assert.deepEqual(status.modifiers, [{ attr: 'hit', delta: -2 }]);
            }
            for (const saveDc of [undefined, null, '', true, NaN, Infinity, -1, 0, 1, 31, 10.5, '20%']) {
                const effect = normalizeSkill({ name: '约束', effects: [{ type, saveDc }] }).effects[0];
                assert.equal(hasOwnDc(effect), false, String(saveDc));
                assert.equal(hasOwnDc(normalizeStatus({ name: '约束', type, saveDc })), false, String(saveDc));
            }
        }
        assert.equal(hasOwnDc(normalizeSkill({ name: '伤害', effects: [{ type: 'damage', saveDc: 10 }] }).effects[0]), false);
        assert.equal(hasOwnDc(normalizeStatus({ name: '减益', type: 'debuff', saveDc: 10 })), false);
    });
});

describe('提示词与完整场景链路', () => {
    it('默认及旧自定义模板只追加一次分类协议，并保留人设魅力协议和原文', () => {
        const custom = '保留自定义规则与原五列表模板\n{{USER_NOTE}}\n{{SITUATION}}';
        for (const template of [undefined, custom, `${custom}\n${SKILL_MECHANICS_REQUIREMENTS}`]) {
            const text = buildSceneRequest({ template, userName: actorName, situation: '保持切磋' });
            assert.equal(text.split(SKILL_MECHANICS_REQUIREMENTS).length, 2);
            assert.equal(text.split(CHARM_REQUIREMENTS).length, 2);
            assert.ok(text.includes(actorName));
            assert.ok(text.includes('保持切磋'));
            if (template) assert.ok(text.startsWith('保留自定义规则与原五列表模板'));
        }
        assert.equal(DEFAULT_SCENE_PROMPT.split(SKILL_MECHANICS_REQUIREMENTS).length, 2);
        for (const term of ['群体(AOE)', '持续伤害', '骰点减益', '命中后', '跳过当前行动', '额外独立掷', '持续伤害=18', '依据不足填 10', 'max(35%', '不是上限']) {
            assert.ok(SKILL_MECHANICS_REQUIREMENTS.includes(term), term);
        }
    });

    it('JSON备援字段覆盖范围、复合效果、可选DC和骰点修正', () => {
        for (const side of ['allies', 'enemies', 'neutral']) {
            const unit = BATTLE_JSON_SCHEMA.value.properties[side].items;
            const skill = unit.properties.skills.items;
            assert.deepEqual(skill.properties.target.enum, ['single', 'group', 'self', 'all', 'random']);
            const effect = skill.properties.effects.items;
            const status = unit.properties.statuses.items;
            for (const schema of [effect, status]) {
                assert.equal(schema.properties.saveDc.type, 'integer');
                assert.equal(schema.properties.saveDc.minimum, 2);
                assert.equal(schema.properties.saveDc.maximum, 30);
                assert.equal(schema.required.includes('saveDc'), false);
                assert.ok(schema.properties.modifiers.items.properties.attr.enum.includes('hit'));
            }
        }
    });

    it('报告经过解析、归一化、引擎仍保留名单、玩家、人设魅力及复合数值', () => {
        const battle = battleFromReport();
        assert.deepEqual(battle.units.map((unit) => unit.name), [actorName, ...opponentNames]);
        const actor = battle.units[0];
        assert.equal(actor.isUser, true);
        assert.equal(actor.social.persona, '谨慎守信，当前立场明确');
        assert.deepEqual(actor.social.charm, [{ targetName: opponentNames[0], value: 32, reason: '当前关系有据' }]);
        assert.equal(actor.skills.length, 4);
        const mixed = actor.skills.find((skill) => skill.name === '折光击');
        assert.deepEqual(mixed.effects.map((effect) => effect.type), ['damage', 'control', 'dot']);
        assert.equal(mixed.effects[2].power, 17);
        assert.equal(mixed.effects[2].saveDc, 12);
    });

    it('报告中的群体纯控制命中后仅给敌人挂状态，不产生即时伤害', () => {
        const battle = battleFromReport();
        battle.rng = new FaceRng(20);
        const actor = battle.units[0];
        const skill = actor.skills.find((entry) => entry.name === '停滞波');
        const hp = battle.units.map((unit) => unit.attributes.HP.current);
        battle._resolveSkill(actor, skill);
        assert.deepEqual(battle.units.map((unit) => unit.attributes.HP.current), hp);
        assert.deepEqual(actor.statuses, []);
        for (const target of battle.units.slice(1)) {
            assert.equal(target.statuses.length, 1);
            assert.equal(target.statuses[0].type, 'control');
            assert.equal(target.statuses[0].saveDc, 14);
            assert.equal(target.statuses[0].duration, 3);
        }
    });

    it('报告中的DoT精确威力进入群体衰减，目标骰点减益进入下一次掷骰', () => {
        const battle = battleFromReport();
        battle.rng = new FaceRng(20);
        const actor = battle.units[0];
        const skill = actor.skills.find((entry) => entry.name === '侵蚀波');
        assert.equal(skill.aim, 130);
        const before = battle.units.map((unit) => unit.attributes.HP.current);
        battle._resolveSkill(actor, skill);
        assert.deepEqual(battle.units.map((unit) => unit.attributes.HP.current), before);
        assert.equal(effectiveStats(actor).hit, 0);
        for (const target of battle.units.slice(1)) {
            const dot = target.statuses.find((status) => status.type === 'dot');
            assert.equal(dot.power, aoeEffectivePower(18, 2, battle.ruleset));
            assert.equal(dot.saveDc, 13);
            assert.equal(dot.duration, 4);
            assert.equal(effectiveStats(target).hit, -2);
            const roll = rollHit(new FaceRng(10), target, actor, target.skills[0], GENERIC_D20);
            assert.equal(roll.nat, 10);
            assert.equal(roll.total, 8);
        }
    });
});
