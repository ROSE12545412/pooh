/**
 * 参战名单 / 观战者 / 技能保底 的测试。
 *
 * 对应三条用户反馈：
 *  1. 「把别的东西认成友方又出现了：人设自述的剑路 / 淇自己在开场说明里列出」
 *  2. 「你直接去规范开始战斗时的提示词，让它把谁是参战人员写明确」
 *  3. 「没人规定必须三个技能而是保底三个技能，不到三个就按照职业或者人设联想出三个」
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { parseSituationReport } from '../src/llm/report-parser.js';
import { buildRoleSkills } from '../src/llm/skill-parse.js';

/** 带完整名单的汇报（现在的标准格式）。 */
const WITH_ROSTER = `## 参战人员名单

### 参战
**【玩家】淇**（保罗之子）｜我方
**塞妮丝·格雷拉特**（生母）｜我方
**保罗·格雷拉特**（生父）｜敌方

### 观战
**莉莉雅·格雷拉特**（女仆）｜守在回廊边，不出手

## 参战双方

### 我方
**【玩家】淇**（保罗之子）
- 位阶：无阶
- 血量：满状态
- 技能：
  - 天道核｜增益｜120｜0｜提供无穷魔力

**塞妮丝·格雷拉特**（生母）
- 位阶：中级治疗术师
- 血量：满状态
- 技能：
  - 中级治愈术｜治疗｜180｜25｜治愈外伤

### 敌方
**保罗·格雷拉特**（生父）
- 位阶：剑神流上级剑士
- 血量：满状态
- 技能：
  - 剑神流·直线突刺｜伤害｜260｜30｜低重心突进

**人设自述的剑路**
- 说明：这是叙述文字，不是人

**淇自己在开场说明里列出，尚未在正文中施展**
- 说明：这也不是人
`;

describe('参战名单：只有名单上的人才是战斗单位', () => {
    const r = parseSituationReport(WITH_ROSTER);

    it('解析成功', () => {
        assert.equal(r.ok, true, r.error);
    });

    it('只收名单上的三个人', () => {
        const names = r.system.combatants.map((u) => u.name);
        assert.equal(r.system.combatants.length, 3, `实际：${names.join('、')}`);
        for (const want of ['淇', '塞妮丝·格雷拉特', '保罗·格雷拉特']) {
            assert.ok(names.some((n) => n.includes(want)), `缺少 ${want}`);
        }
    });

    it('观战者被排除', () => {
        assert.ok(
            !r.system.combatants.some((u) => u.name.includes('莉莉雅')),
            '观战的人不该进战斗单位',
        );
    });

    it('叙述性标题不会被当成参战者（真实 bug 的回归）', () => {
        // 用户实测报过：「把别的东西认成友方又出现了：人设自述的剑路」
        for (const noise of ['人设自述', '开场说明', '尚未在正文中施展']) {
            assert.ok(
                !r.system.combatants.some((u) => u.name.includes(noise)),
                `「${noise}」不该被当成参战者：${r.system.combatants.map((u) => u.name).join('、')}`,
            );
        }
    });

    it('名单里的【玩家】标记被用来定位玩家角色', () => {
        const qi = r.system.combatants.find((u) => u.name.includes('淇'));
        assert.equal(qi.isUser, true, '淇 应当是玩家角色');
    });

    it('阵营按分节正确归属', () => {
        const ally = r.system.combatants.filter((u) => u.side === 'ally').map((u) => u.name);
        const enemy = r.system.combatants.filter((u) => u.side === 'enemy').map((u) => u.name);
        assert.equal(ally.length, 2, `我方：${ally.join('、')}`);
        assert.equal(enemy.length, 1, `敌方：${enemy.join('、')}`);
    });
});

describe('没有名单时的回退（旧格式汇报仍要能用）', () => {
    const legacy = `## 参战双方
### 我方
**甲**（剑士）
- 位阶：上级剑士
- 血量：满状态
### 敌方
**乙**（法师）
- 位阶：中级法师
- 血量：满状态
`;
    const r = parseSituationReport(legacy);

    it('仍然能解析出单位', () => {
        assert.equal(r.ok, true, r.error);
        assert.equal(r.system.combatants.length, 2, r.system.combatants.map((u) => u.name).join('、'));
    });

    it('纯标题（无任何标准字段）仍会被丢弃', () => {
        const withNoise = parseSituationReport(`${legacy}
**某个招式名**
- 这是一句说明
`);
        assert.ok(
            !withNoise.system.combatants.some((u) => u.name.includes('某个招式名')),
            '没有标准字段的标题不该算单位',
        );
    });
});

describe('技能保底 3 条（按职业 / 身份联想）', () => {
    it('buildRoleSkills 认得出常见身份', () => {
        assert.equal(buildRoleSkills({ tier: '中级治疗术师' }).role, 'healer');
        assert.equal(buildRoleSkills({ tier: '剑神流上级剑士' }).role, 'swordsman');
        assert.equal(buildRoleSkills({ tier: '水神流中级剑士', notes: '前宫廷禁卫侍女' }).role, 'guard');
        assert.equal(buildRoleSkills({ tier: '大魔法师' }).role, 'mage');
    });

    it('治疗师补出来的是治疗技，不是攻击技', () => {
        const skills = buildRoleSkills({ tier: '中级治疗术师' }).skills;
        assert.ok(skills.length >= 3);
        for (const s of skills) {
            assert.ok(
                s.effects.some((e) => e.type === 'heal'),
                `${s.name} 应当是治疗技`,
            );
        }
    });

    it('补出来的技能都有可掷骰的数值', () => {
        for (const s of buildRoleSkills({ tier: '剑神流上级剑士' }).skills) {
            assert.ok(s.power > 0, `${s.name} 缺威力`);
            assert.ok(s.aim > 0, `${s.name} 缺命中`);
            assert.equal(typeof s.cost, 'number', `${s.name} 缺消耗`);
            assert.ok(s.source.includes('定位推导'), '应当标明推导来源');
        }
    });

    it('身份认不出来时返回空（不硬塞）', () => {
        assert.deepEqual(buildRoleSkills({ tier: '无阶', name: '某个神秘存在' }).skills, []);
    });

    it('端到端：只写 1 条技能的角色会被补足到 3 条', () => {
        const r = parseSituationReport(`## 参战人员名单
### 参战
**甲**（治疗术师）｜我方
**乙**（剑士）｜敌方
### 观战
无
## 参战双方
### 我方
**甲**（治疗术师）
- 位阶：中级治疗术师
- 血量：满状态
- 技能：
  - 治愈术｜治疗｜180｜25｜治疗外伤
### 敌方
**乙**（剑士）
- 位阶：上级剑士
- 血量：满状态`);
        for (const u of r.system.combatants) {
            assert.equal(u.skills.length, 3, `${u.name} 的技能应当被补足到 3 条，实际 ${u.skills.length}`);
        }
    });

    it('已经有 3 条以上的不会被削减', () => {
        const r = parseSituationReport(`## 参战双方
### 我方
**甲**（剑士）
- 位阶：上级剑士
- 技能：
  - 一｜伤害｜100｜10｜a
  - 二｜伤害｜110｜10｜b
  - 三｜伤害｜120｜10｜c
  - 四｜伤害｜130｜10｜d
### 敌方
**乙**（法师）
- 位阶：中级法师
- 技能：
  - 法术｜伤害｜100｜10｜x
`);
        const a = r.system.combatants.find((u) => u.name === '甲');
        assert.ok(a.skills.length >= 4, `不该削减已有技能，实际 ${a.skills.length}`);
    });
});

describe('提示词的规范要求（治本的地方）', () => {
    const promptSource = readFileSync(new URL('../src/llm/scene-prompt.js', import.meta.url), 'utf8');

    it('模板要求先写「参战人员名单」', () => {
        assert.ok(promptSource.includes('参战人员名单'), '模板应当有参战人员名单一节');
    });

    it('名单区分【参战】与【观战】', () => {
        assert.ok(promptSource.includes('### 参战'), '应当有参战小节');
        assert.ok(promptSource.includes('### 观战'), '应当有观战小节');
        assert.ok(promptSource.includes('观战'), '应当说明观战者不参与掷骰');
    });

    it('明确「详细条目只写参战名单里的人」', () => {
        assert.ok(promptSource.includes('唯一权威来源'), '应当说明名单是权威来源');
        assert.ok(/名单里没有的人|名单之外/.test(promptSource), '应当禁止名单外的人出现');
    });

    it('点名禁止把叙述文字写成人名格式（真实 bug 的来源）', () => {
        assert.ok(promptSource.includes('人设自述'), '应当点名「人设自述」这类写法');
        assert.ok(promptSource.includes('技能名') && promptSource.includes('加粗'), '应当禁止技能名加粗成标题');
    });

    it('技能说明是「保底 3 条」而不是「必须 3 条」', () => {
        assert.ok(promptSource.includes('保底'), '应当说明 3 条是保底');
        assert.ok(/按这个人的「职业 \/ 身份 \/ 人设」联想补足/.test(promptSource), '应当说明可以按职业联想');
    });
});
