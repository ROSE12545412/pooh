import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { normalizeSocial, normalizeCombatant, normalizePowerSystem } from '../src/core/schema.js';
import { parseSituationReport } from '../src/llm/report-parser.js';
import { DEFAULT_SCENE_PROMPT, CHARM_REQUIREMENTS, buildSceneRequest } from '../src/llm/scene-prompt.js';
import { BATTLE_JSON_SCHEMA } from '../src/prompts/index.js';
import { Battle } from '../src/combat/engine.js';

const ally = '远行者·霁';
const enemies = ['守门人岚', '流亡者朔'];
const detail = (name, social = '') => `**${name}**（剑士）\n- 位阶：老兵\n- 人设：谨慎重诺，守护同行者\n- 血量：满状态\n- 技能：\n  - 试锋｜伤害｜80｜5｜试探一击\n${social}\n- 装备：铁剑`;
function report(rows, roster = false) {
    return (roster ? `## 参战人员名单\n### 参战\n**${ally}**（剑士）｜我方\n${enemies.map((name) => `**${name}**（剑士）｜敌方`).join('\n')}\n### 观战\n无\n## 参战双方\n` : '') +
        `### 我方\n${detail(ally, rows)}\n### 敌方\n${detail(enemies[0], `- 对敌魅力：${ally}｜12｜阵营敌对但认可其守信`)}\n${detail(enemies[1])}`;
}

describe('定向魅力数据协议', () => {
    it('缺失为空，非法数值不会伪装成零；明确零有效，有限值夹到范围内', () => {
        assert.deepEqual(normalizeSocial(), { persona: '', charm: [] });
        assert.deepEqual(normalizeCombatant({ name: ally }).social, { persona: '', charm: [] });
        const invalid = [undefined, null, '', ' ', false, true, [], {}, NaN, Infinity, -Infinity, 'Infinity', 'NaN', '未知', '80分', '0x10'];
        const input = invalid.map((value, i) => ({ targetName: `无效${i}`, value }));
        const social = normalizeSocial({ persona: ' 守信 ', charm: [...input,
            { targetName: '明确零', value: 0 }, { targetName: '下限', value: -3 },
            { targetName: '上限', value: 105 }, { targetName: '小数', value: ' 31.5 ', reason: ' 旧识 ' },
            { targetName: '', value: 80 }, { targetName: '小数', value: 99 },
        ] });
        assert.equal(social.persona, '守信');
        assert.deepEqual(social.charm, [
            { targetName: '明确零', value: 0, reason: '' }, { targetName: '下限', value: 0, reason: '' },
            { targetName: '上限', value: 100, reason: '' }, { targetName: '小数', value: 31.5, reason: '旧识' },
        ]);
        assert.deepEqual(normalizeSocial({ charm: {} }).charm, []);
    });

    for (const roster of [false, true]) {
        for (const form of ['repeated', 'indented', 'flat', 'plain']) {
            it(`多目标不会成为参战者或技能：名单=${roster} 格式=${form}`, () => {
                const rows = form === 'repeated'
                    ? `- **对敌魅力**：${enemies[0]}｜64｜旧识但立场冲突\n- 对敌魅力：${enemies[1]}｜0｜不信任`
                    : `- 对敌魅力：\n${enemies.map((name, i) => `${form === 'indented' ? '  ' : ''}${form === 'plain' ? '' : '- '}**${name}**｜${i ? 0 : 64}｜${i ? '不信任' : '旧识但立场冲突'}`).join('\n')}`;
                const parsed = parseSituationReport(report(rows, roster));
                assert.equal(parsed.ok, true, parsed.error);
                const units = parsed.system.combatants;
                assert.deepEqual(units.map((u) => u.name), [ally, ...enemies]);
                assert.deepEqual(units[0].social, { persona: '谨慎重诺，守护同行者', charm: [
                    { targetName: enemies[0], value: 64, reason: '旧识但立场冲突' },
                    { targetName: enemies[1], value: 0, reason: '不信任' },
                ] });
                assert.equal(units[1].social.charm[0].value, 12);
                assert.deepEqual(units[2].social.charm, []);
                for (const unit of units) {
                    assert.ok(unit.skills.some((skill) => skill.name === '试锋'));
                    assert.ok(unit.skills.every((skill) => ![...enemies, '对敌魅力'].some((name) => skill.name.includes(name))));
                }
            });
        }
    }

    it('缺数值或非有限值不会从理由中抓取数字；缩进重复字段也不会成为技能', () => {
        const parsed = parseSituationReport(report(`  - 对敌魅力：${enemies[0]}｜｜认识20年但缺乏依据\n  - 对敌魅力：${enemies[1]}｜Infinity｜未知`));
        assert.equal(parsed.ok, true, parsed.error);
        assert.deepEqual(parsed.system.combatants[0].social.charm, []);
        assert.ok(parsed.system.combatants[0].skills.every((s) => !s.name.includes('对敌魅力')));
    });

    it('归一化、引擎构造、快照、存档恢复保留字段且不会共享对象', () => {
        const parsed = parseSituationReport(report(`- 对敌魅力：${enemies[0]}｜64｜旧识`));
        const system = normalizePowerSystem(parsed.system);
        const battle = new Battle(system, { seed: 'social-preservation' });
        assert.deepEqual(battle.units[0].social, system.combatants[0].social);
        const restored = Battle.fromState(JSON.parse(JSON.stringify(battle.toState())));
        assert.deepEqual(restored.units[0].social, system.combatants[0].social);
        const snapshot = battle.unitsSnapshot;
        snapshot[0].social.charm[0].value = 1;
        battle.units[0].social.charm[0].value = 2;
        assert.equal(system.combatants[0].social.charm[0].value, 64);
        assert.equal(restored.units[0].social.charm[0].value, 64);
    });

    it('同名同阵营合并保留后续补建的人设及未重复目标', () => {
        const system = normalizePowerSystem({ combatants: [
            { name: ally, side: 'ally' },
            { name: ally, side: 'ally', social: { persona: '守信', charm: [{ targetName: enemies[0], value: 4, reason: '初识' }] } },
        ] });
        assert.equal(system.combatants[0].social.persona, '守信');
        assert.equal(system.combatants[0].social.charm[0].value, 4);
    });

    it('默认和旧自定义提示词都包含协议，并保留自定义正文与运行时参数', () => {
        assert.ok(DEFAULT_SCENE_PROMPT.includes('- 对敌魅力：目标姓名｜数值｜关系/好感/立场依据'));
        const custom = '保留用户自己的战斗格式\n{{USER_NOTE}}\n{{SITUATION}}';
        const text = buildSceneRequest({ template: custom, userName: ally, situation: '只切磋' });
        assert.ok(text.startsWith('保留用户自己的战斗格式'));
        assert.ok(text.includes(ally));
        assert.ok(text.includes('只切磋'));
        assert.ok(text.includes(CHARM_REQUIREMENTS));
        assert.equal(buildSceneRequest().split(CHARM_REQUIREMENTS).length, 2);
    });

    it('结构化 schema 为双方提供严格 social 字段及数值边界', () => {
        for (const group of ['allies', 'enemies', 'neutral']) {
            const unit = BATTLE_JSON_SCHEMA.value.properties[group].items;
            assert.ok(unit.required.includes('social'));
            const social = unit.properties.social;
            assert.deepEqual(social.required, ['persona', 'charm']);
            assert.deepEqual(social.properties.charm.items.required, ['targetName', 'value', 'reason']);
            assert.equal(social.properties.charm.items.properties.value.minimum, 0);
            assert.equal(social.properties.charm.items.properties.value.maximum, 100);
        }
    });
});
