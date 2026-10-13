import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { Rng } from '../src/core/rng.js';
import { GENERIC_D20 } from '../src/core/ruleset.js';
import {
    formatCombatantBlock, normalizeCombatant, normalizeEquipment, normalizeEquipmentChecks,
    normalizeSkill, normalizeSlot, parseEquipmentLine,
} from '../src/core/schema.js';
import { Battle, effectiveStats, rollDamage, rollHit, rollInitiative, rollStatusSave } from '../src/combat/engine.js';
import { parseSituationReport } from '../src/llm/report-parser.js';
import { DEFAULT_SCENE_PROMPT, EQUIPMENT_CHECK_REQUIREMENTS, buildSceneRequest } from '../src/llm/scene-prompt.js';
import { BATTLE_JSON_SCHEMA } from '../src/prompts/index.js';

/** All floats are intentional; extra/random display rolls fail immediately. */
class SequenceRng extends Rng {
    constructor(...values) { super(1); this.values = values; }
    next() {
        assert.ok(this.values.length, '不得为明细、天然值或未支持规则额外掷骰');
        this.calls++;
        return this.values.shift();
    }
}
const dice = (...faces) => new SequenceRng(...faces.map((face) => (face - 0.5) / 20));
const RULES = { ...GENERIC_D20, critFormula: '0', fumbleFormula: '0' };
function unit(overrides = {}) {
    const { attributes = {}, ...rest } = overrides;
    return normalizeCombatant({
        id: 'actor', name: '行动者', side: 'ally', attributeBasis: 'base',
        attributes: { HP: 1000, MP: 100, Atk: 20, Armor: 5, Speed: 10, Evasion: 10, ...attributes },
        skills: [], statuses: [], equipment: [], ...rest,
    });
}
const target = (overrides = {}) => unit({ id: 'target', name: '目标', side: 'enemy', ...overrides });
const gear = (name, checks = {}, bonuses = {}, extra = {}) => ({ name, checks, bonuses, ...extra });
const move = (extra = {}) => normalizeSkill({ name: '检验招式', aim: 100, power: 30, ...extra });
const hit = (rng, equipment, defender = target(), rules = RULES, skill = move()) =>
    rollHit(rng, unit({ equipment }), defender, skill, rules);

function parsedScene(equipmentRows, enemyRows = '- 武器与装备：无') {
    const result = parseSituationReport(`## 参战双方
### 我方
**行动者**（自由设定）
- 位阶：凡人
- 血量：满状态
${equipmentRows}
- 技能：
  - 检验招式｜单体｜伤害｜30｜0｜0｜-｜普通攻击
### 敌方
**目标**（自由设定）
- 位阶：凡人
- 血量：满状态
${enemyRows}
- 技能：
  - 还击｜单体｜伤害｜20｜0｜0｜-｜普通攻击`);
    assert.equal(result.ok, true, result.error);
    return result.system.combatants.map((entry) => normalizeCombatant(entry));
}

function assertStatTotals(rows) {
    for (const row of rows) assert.equal(row.base + row.parts.reduce((sum, part) => sum + part.delta, 0), row.value, row.attr);
}

describe('装备数据协议与场景格式', () => {
    it('checks、additive、libraryId、source 和 equipped:false 重复归一化不丢失', () => {
        const original = normalizeEquipment(gear('刻印物', { attack: 'advantage', defense: 'disadvantage' }, { hit: 2.5, Speed: -1 }, {
            libraryId: 'gear-01', source: 'custom-library', bonusMode: 'additive', equipped: false,
        }));
        assert.deepEqual(normalizeEquipment(original), original);
        assert.equal(original.slot, 'other');
        assert.equal(original.libraryId, 'gear-01');
        assert.equal(original.equipped, false);
        const skill = normalizeSkill({ ...move(), advantage: 4, libraryId: 'skill-01', source: 'custom-library' });
        assert.equal(normalizeSkill(skill).libraryId, 'skill-01');
        assert.equal(skill.advantage, 4, '旧 advantage 仍然是数值，不转换为掷两颗骰');
        assert.deepEqual(normalizeEquipment({ name: '旧装备' }).checks, { attack: 'normal', defense: 'normal' });
    });

    it('只接受明确检定标签与数字，百分比/定性/旧数值优势不会伪造规则', () => {
        const item = normalizeEquipment('武器·短刃（命中+2.5、速度-1；攻击检定：优势；防御检定：劣势）');
        assert.deepEqual(item.bonuses, { hit: 2.5, Speed: -1 });
        assert.deepEqual(item.checks, { attack: 'advantage', defense: 'disadvantage' });
        for (const text of ['拥有绝对优势', '攻击判定优势+3', '攻击优势+20%', '近战时攻击优势', '攻击优势（仅近战时）']) {
            assert.deepEqual(normalizeEquipmentChecks(null, text), { attack: 'normal', defense: 'normal' }, text);
        }
        assert.deepEqual(normalizeEquipment('铁片（攻击+20%、护甲30、速度-2）').bonuses, { Speed: -2 });
        assert.deepEqual(normalizeEquipment({ name: '徽章', bonuses: { Atk: '20%', Armor: '5', Speed: '-1.5' } }).bonuses, { Armor: 5, Speed: -1.5 });
        const explicitEmpty = normalizeEquipment({ name: '刻印物', raw: '攻击检定：优势；命中+99', bonuses: {}, checks: {} });
        assert.deepEqual(explicitEmpty.bonuses, {});
        assert.equal(explicitEmpty.checks.attack, 'normal');
    });

    it('饰品映射优先明确类型或长别名，不被法宝/剑等短词截断', () => {
        for (const text of ['法宝饰品', '剑形吊坠', '配饰', '胸针', '徽章', 'earring', 'necklace']) assert.equal(normalizeSlot(text), 'accessory', text);
        assert.equal(normalizeEquipment({ name: '剑形物', slot: '饰品' }).slot, 'accessory');
    });

    it('六列装备行不拆逗号/分号，说明列的重复数字不参与加值', () => {
        const rows = `- 武器与装备：
  - 武器｜短刃｜命中+2，攻击+4；速度-1｜优势｜普通｜有利：精准，命中+99不是加值列；不利：需靠近
饰品｜剑形吊坠｜闪避+1｜普通｜优势｜有利：干扰来袭；无其它检定规则
| 防具 | 轻甲 | 护甲+3；速度-2 | 普通 | 劣势 | 有利：防护；不利：转向受限 |`;
        const [actor] = parsedScene(rows);
        assert.equal(actor.equipment.length, 3);
        assert.deepEqual(actor.equipment.map((entry) => entry.slot), ['weapon', 'accessory', 'armor']);
        assert.deepEqual(actor.equipment[0].bonuses, { hit: 2, Atk: 4, Speed: -1 });
        assert.deepEqual(actor.equipment.map((entry) => entry.checks), [
            { attack: 'advantage', defense: 'normal' }, { attack: 'normal', defense: 'advantage' }, { attack: 'normal', defense: 'disadvantage' },
        ]);
        assert.equal(actor.skills.length, 1, '装备行不可进入技能列表或生成额外人物');
        assert.equal(effectiveStats(actor).hit, 2);
    });

    it('重复字段、独立饰品字段、表头和加粗子行都可靠保留', () => {
        const [actor] = parsedScene(`- 武器与装备：武器｜短刃｜命中+1｜普通｜普通｜无明确检定优劣势
- 饰品：无名信物（闪避+1）
- 武器与装备：
  - | 部位 | 物品名 | 带符号加值 | 攻击检定 | 防御检定 | 优劣势依据 |
  - | --- | --- | --- | --- | --- | --- |
  - **饰品**｜**剑形吊坠**｜命中+2｜攻击检定：优势｜防御检定：普通｜明确说明
- 护具：无`);
        assert.equal(actor.equipment.length, 3);
        assert.equal(actor.equipment[1].slot, 'accessory');
        assert.equal(actor.equipment[1].name, '无名信物');
        assert.equal(actor.equipment[2].name, '剑形吊坠');
        assert.equal(actor.equipment[2].checks.attack, 'advantage');
    });

    it('新旧文本往返保留真实检定、additive 与未装备标记', () => {
        const actor = unit({ equipment: [gear('胸针', { defense: 'advantage' }, { hit: 2 }, { bonusMode: 'additive', equipped: false })] });
        const line = formatCombatantBlock(actor).match(/装备: "([^"]*)"/)[1];
        const [restored] = parseEquipmentLine(line);
        assert.equal(restored.name, '胸针');
        assert.deepEqual(restored.bonuses, { hit: 2 });
        assert.equal(restored.checks.defense, 'advantage');
        assert.equal(restored.bonusMode, 'additive');
        assert.equal(restored.equipped, false);
    });

    it('默认/自定义场景只追加一次必需协议，JSON schema 约束一致', () => {
        for (const template of [undefined, DEFAULT_SCENE_PROMPT, '用户保留的自定义文本', `自定义\n${EQUIPMENT_CHECK_REQUIREMENTS}`]) {
            const request = buildSceneRequest({ template });
            assert.equal(request.split(EQUIPMENT_CHECK_REQUIREMENTS).length - 1, 1);
            assert.match(request, /部位｜物品名｜带符号加值｜攻击检定｜防御检定｜优劣势依据/);
            assert.match(request, /2d20 取高/);
            assert.match(request, /2d20 取低/);
            assert.match(request, /自定义技能\/装备库条目是同名冲突的权威来源/);
            if (template?.startsWith('用户')) assert.ok(request.startsWith(template));
        }
        const equipmentSchema = BATTLE_JSON_SCHEMA.value.properties.allies.items.properties.equipment.items;
        assert.deepEqual(equipmentSchema.properties.checks.required, ['attack', 'defense']);
        assert.ok(equipmentSchema.required.includes('bonusMode'));
        assert.ok(equipmentSchema.required.includes('equipped'));
    });
});

describe('真实装备 d20 检定与逐项来源', () => {
    it('攻击优势真实掷两颗取高，所有修正仅加在保留值上一次', () => {
        const attacker = unit({
            equipment: [gear('短刃', { attack: 'advantage' }, { hit: 2, Atk: 4, Armor: -1, Speed: -2, Evasion: 1 })],
            statuses: [{ name: '干扰', type: 'debuff', duration: 1, modifiers: [{ attr: 'hit', delta: -1 }] }],
        });
        const defender = target({ equipment: [gear('轻甲', {}, { Evasion: 3, Armor: 2, Speed: 1 })] });
        const rng = dice(3, 18);
        const skill = move({ aim: 105 });
        const result = rollHit(rng, attacker, defender, skill, GENERIC_D20);
        assert.equal(result.nat, 18);
        assert.equal(result.total, 19.5);
        assert.equal(result.target, 13);
        assert.deepEqual(result.dice.map(({ rolls, total, count, kept, keep }) => ({ rolls, total, count, kept, keep })), [{ rolls: [3, 18], total: 18, count: 2, kept: 18, keep: 'highest' }]);
        assert.deepEqual(result.modifiers.map((part) => part.value), [0.5, 2, -1]);
        assert.equal(result.nat + result.modifiers.reduce((sum, part) => sum + part.value, 0), result.total);
        assert.equal(result.targetModifiers.reduce((sum, part) => sum + part.value, 0), result.target);
        assertStatTotals(result.statSources.attacker);
        assertStatTotals(result.statSources.defender);
        assert.match(result.notes.join('\n'), /3、18，取高 18/);
        const damage = rollDamage(rng, attacker, defender, skill, result, { ...RULES, damageFormula: 'Atk + power - Armor' });
        assert.equal(damage.damage, 47);
        assert.equal(damage.scope.Atk, 24);
        assert.equal(damage.scope.Armor, 7);
        assertStatTotals(damage.statSources.attacker);
        const initiative = rollInitiative(dice(10), [attacker], GENERIC_D20).order[0];
        assert.equal(initiative.total, 18);
        assert.equal(initiative.statSources.find((entry) => entry.attr === 'Speed').parts[0].delta, -2);
        JSON.parse(JSON.stringify(result));
        assert.equal(rng.calls, 2, '展示/伤害确定式不再掷命中骰');
    });

    it('攻击劣势取低；暴击和大失败使用保留值而非丢弃的天然骰', () => {
        const dis = [gear('沉重工具', { attack: 'disadvantage' })];
        const low = hit(dice(20, 4), dis, target(), GENERIC_D20);
        assert.equal(low.nat, 4);
        assert.equal(low.outcome, 'miss');
        assert.equal(low.dice[0].keep, 'lowest');
        assert.equal(hit(dice(20, 1), dis, target(), GENERIC_D20).outcome, 'fumble');
        assert.equal(hit(dice(1, 20), [gear('精密工具', { attack: 'advantage' })], target(), GENERIC_D20).outcome, 'crit');
    });

    it('防御优势使来袭方取低，防御劣势使来袭方取高，命名可追溯', () => {
        for (const [defense, mode, kept] of [['advantage', 'disadvantage', 4], ['disadvantage', 'advantage', 18]]) {
            const result = hit(dice(18, 4), [], target({ equipment: [gear('护符', { defense })] }));
            assert.equal(result.nat, kept);
            assert.equal(result.equipmentCheck.mode, mode);
            assert.deepEqual(result.equipmentCheck.sources.map(({ role, check, mode: sourceMode, attackMode }) => ({ role, check, sourceMode, attackMode })), [{ role: 'defender', check: 'defense', sourceMode: defense, attackMode: mode }]);
        }
    });

    it('多个同向来源仍只掷两颗；任一反向来源抵消全部优劣势为单骰', () => {
        const equipment = [gear('工具甲', { attack: 'advantage' }), gear('工具乙', { attack: 'advantage' })];
        const rng = dice(2, 17);
        assert.equal(hit(rng, equipment).nat, 17);
        assert.equal(rng.calls, 2);
        const cancelledRng = dice(11);
        const cancelled = hit(cancelledRng, equipment, target({ equipment: [gear('护符', { defense: 'advantage' })] }));
        assert.equal(cancelled.equipmentCheck.mode, 'normal');
        assert.equal(cancelled.equipmentCheck.cancelled, true);
        assert.equal(cancelled.equipmentCheck.applied, false);
        assert.equal(cancelled.equipmentCheck.sources.length, 3);
        assert.deepEqual(cancelled.dice[0].rolls, [11]);
        assert.equal(cancelled.total, 11);
        assert.equal(cancelledRng.calls, 1);
    });

    it('未装备来源无效，攻击与防御各用当前角色的相应轴', () => {
        const result = hit(dice(9), [
            gear('背包中的物品', { attack: 'advantage' }, { hit: 99 }, { equipped: false }),
            gear('防具', { defense: 'advantage' }),
        ], target({ equipment: [gear('武器', { attack: 'advantage' })] }));
        assert.equal(result.total, 9);
        assert.deepEqual(result.equipmentCheck.sources, []);
        assert.deepEqual(result.dice[0].rolls, [9]);
    });

    it('旧数值 skill.advantage 与没有装备检查的单位仍是一颗骰', () => {
        const result = hit(dice(10), [], target(), GENERIC_D20, move({ advantage: 7, aim: 130 }));
        assert.equal(result.total, 13);
        assert.equal(result.equipmentCheck.mode, 'normal');
        assert.deepEqual(result.dice[0].rolls, [10]);
        assert.deepEqual(result.notes, []);
    });

    it('base/effective/未知口径只叠明确允许的一次，additive 不凭空减旧装备', () => {
        for (const basis of ['base', 'effective', 'unspecified']) {
            const actor = unit({ attributeBasis: basis, equipment: [
                gear('旧剑', {}, { Atk: 5, hit: 1 }),
                gear('新增胸针', { attack: 'advantage' }, { Atk: 3, hit: -2 }, { bonusMode: 'additive', libraryId: 'custom', source: 'custom-library' }),
                gear('卸下物品', {}, { Atk: 99 }, { bonusMode: 'additive', equipped: false }),
            ] });
            assert.equal(effectiveStats(actor).Atk, basis === 'base' ? 28 : 23);
            assert.equal(effectiveStats(actor).hit, basis === 'base' ? -1 : -2);
            const result = rollHit(dice(4, 15), actor, target(), move(), RULES);
            assert.equal(result.total, basis === 'base' ? 14 : 13);
            assert.equal(result.equipmentCheck.applied, true);
            if (basis !== 'base') {
                assert.match(result.notes.join('\n'), /未额外叠加装备 base/);
                assert.match(result.notes.join('\n'), /旧有效属性中的装备数值不可分离/);
            }
        }
    });

    it('简单自定义主d20可取高，但不伪造默认式的属性算术明细', () => {
        const result = hit(dice(4, 16), [gear('精密工具', { attack: 'advantage' })], target(), { ...RULES, id: 'custom', hitFormula: '1d20 + Atk - Armor' });
        assert.equal(result.total, 31);
        assert.equal(result.nat, 16);
        assert.equal(result.equipmentCheck.applied, true);
        assert.equal(result.modifiers, null);
        assert.deepEqual(result.variables, { Atk: 20, Armor: 5, Evasion: 10 });
    });

    it('复杂/条件/多骰/概率命中保留原规则、原RNG序列并明确未应用', () => {
        const cases = [
            [{ hitFormula: '(d20 + Atk) * 2' }, [0.45]],
            [{ hitFormula: 'max(d20, d20)' }, [0.45, 0.1, 0.9]],
            [{ hitFormula: '0 ? d20 : 7' }, [0.45]],
            [{ hitFormula: '2d6 + 3' }, [0.4, 0, 0.99]],
            [{ hitFormula: 'd20 + rand(0, 2)' }, [0.45, 0.25]],
            [{ hitFormula: 'd100' }, [0.45]],
            [{ hitMode: 'chance', hitChanceFormula: '0.6' }, [0.45, 0.4]],
        ];
        for (const [custom, values] of cases) {
            const rules = { ...RULES, id: 'custom', ...custom };
            const plainRng = new SequenceRng(...values);
            const gearRng = new SequenceRng(...values);
            const plain = hit(plainRng, [], target(), rules);
            const equipped = hit(gearRng, [gear('精密工具', { attack: 'advantage' })], target(), rules);
            for (const key of ['nat', 'total', 'target', 'dice', 'random', 'outcome', 'modifiers']) assert.deepEqual(equipped[key], plain[key], `${custom.hitFormula ?? 'chance'}: ${key}`);
            assert.equal(gearRng.calls, plainRng.calls);
            assert.equal(equipped.equipmentCheck.applied, false);
            assert.equal(equipped.equipmentCheck.supported, false);
            assert.match(equipped.notes.join('\n'), /未应用装备 d20 优势/);
        }
    });
});

describe('装备贯通场景与真实战斗且不改变已有状态机制', () => {
    it('从六列场景解析到最终命中：防御取低、加值/闪避来源都真实生效', () => {
        const [actor, defender] = parsedScene('- 武器与装备：武器｜长杆｜命中+2｜普通｜普通｜无明确检定优劣势',
            '- 武器与装备：饰品｜护符｜闪避+1｜普通｜优势｜明确干扰来袭攻击');
        const result = rollHit(dice(18, 11), actor, defender, actor.skills[0], RULES);
        assert.equal(result.nat, 11);
        assert.equal(result.total, 13);
        assert.equal(result.target, 11);
        assert.equal(result.outcome, 'hit');
        assert.ok(result.modifiers.some((part) => /长杆/.test(part.source) && part.value === 2));
        assert.ok(result.targetModifiers.some((part) => /护符/.test(part.source) && part.value === 1));
    });

    it('AOE逐目标合并装备，控制/DoT/负修正共享该次命中、不追加命中骰', () => {
        const skill = move({ id: 'area', target: 'group', effects: [
            { type: 'damage', power: 30, duration: 0 },
            { type: 'control', power: 0, duration: 2, saveDc: 10 },
            { type: 'dot', power: 6, duration: 2, saveDc: 10 },
            { type: 'debuff', power: 0, duration: 2, modifiers: [{ attr: 'hit', delta: -2 }] },
        ] });
        const battle = new Battle({ combatants: [
            unit({ skills: [skill], equipment: [gear('精密工具', { attack: 'advantage' }, { hit: 1 })] }),
            target({ id: 'foe-a', name: '目标甲', equipment: [gear('護符', { defense: 'advantage' })] }),
            target({ id: 'foe-b', name: '目标乙' }),
        ] }, { ruleset: { ...RULES, damageFormula: 'power', dotFormula: '0' }, seed: 1 });
        const rng = dice(12, 3, 16);
        battle.rng = rng;
        battle._resolveSkill(battle.units[0], battle.units[0].skills[0]);
        const attacks = battle.log.filter((entry) => entry.data?.hit).map((entry) => entry.data);
        assert.equal(attacks.length, 2);
        assert.deepEqual(attacks.map((entry) => entry.hit.equipmentCheck.rolls), [[12], [3, 16]]);
        assert.deepEqual(attacks.map((entry) => entry.hit.total), [13, 17]);
        assert.deepEqual(attacks.map((entry) => entry.damage.damage), [21, 21]);
        for (const enemy of battle.units.slice(1)) {
            assert.deepEqual(enemy.statuses.map((entry) => entry.type), ['control', 'dot', 'debuff']);
            assert.equal(enemy.statuses[1].power, 4, 'DoT仍只按原AOE倍率衰减一次');
            assert.equal(enemy.statuses[0].duration, 2);
            assert.equal(enemy.statuses[0].saveDc, 10);
            assert.equal(effectiveStats(enemy).hit, -2);
        }
        assert.equal(rng.calls, 3);
    });

    it('装备攻击/防御优劣势不渗入每回合控制与DoT独立豁免', () => {
        const actor = unit({ equipment: [gear('胸针', { attack: 'advantage', defense: 'advantage' }, { hit: 2 })] });
        const rng = dice(7);
        const check = rollStatusSave(rng, actor, { type: 'control', saveDc: 10, name: '束缚' });
        assert.equal(check.nat, 7);
        assert.equal(check.total, 9);
        assert.equal(rng.calls, 1);
    });
});
