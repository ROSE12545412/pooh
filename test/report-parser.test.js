/**
 * 战况汇报**本地解析**的测试。
 *
 * 这个模块存在的理由：原来的流程要把「正文模型写出的结构化汇报」
 * 再交给第二个模型转 JSON，而那个模型往往是便宜的小模型，扛不住长文本 ——
 * 用户看到的就是「汇报里双方都写得清清楚楚，点开战却说没识别到人」。
 *
 * 所以现在**先本地解析**。测试素材用的是真实汇报（`test/fixtures/situation-report-sample.md`），
 * 而不是我编的理想格式 —— 真实文本才有回归价值。
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { parseSituationReport, percentFromStatus } from '../src/llm/report-parser.js';

describe('明确名单与阵营边界', () => {
    const detail = (name) => `**${name}**（战士）\n- **位阶**：老兵\n- **血量**：100/100\n- **魔量**：30/30\n- **技能**：斩击`;
    const roster = '## 参战人员名单\n### 参战\n- **甲**（战士）｜我方\n- **乙**（战士）｜敌方\n### 观战\n- **甲的同伴**（观众）｜旁观\n## 参战双方\n';
    it('名单先于泛参战标题解析，描述不得包含匹配冒充人物', () => {
        const result = parseSituationReport(roster + '### 我方\n' + detail('甲') + '\n' + detail('甲的战斗描述') + '\n### 敌方\n' + detail('乙'));
        assert.equal(result.ok, true, result.error);
        assert.deepEqual(result.system.combatants.map((u) => [u.name, u.side]), [['甲', 'ally'], ['乙', 'enemy']]);
    });
    it('详细资料没有阵营章节时使用名单逐人声明，参战者不是我方别名', () => {
        const result = parseSituationReport(roster + '### 参战者\n' + detail('甲') + '\n' + detail('乙'));
        assert.equal(result.ok, true, result.error);
        assert.deepEqual(result.system.combatants.map((u) => u.side), ['ally', 'enemy']);
    });
    for (const withRoster of [true, false]) {
        for (const indent of ['  ', '']) {
            it(`加粗招式属于人物：名单=${withRoster}，缩进=${indent.length}`, () => {
                const fighter = (name) => `#### **${name}**（战士）\n- 位阶：老兵\n- 血量：100/100\n- 魔量：30/30\n- 技能：\n${indent}- **破空斩**｜物理｜80｜5｜斩击目标\n${indent}- **护身诀**｜防御｜30｜3｜保护自身\n- 武器与装备：铁剑\n- 临时属性：无`;
                const result = parseSituationReport((withRoster ? roster : '') + '### 我方\n' + fighter('甲') + '\n### 敌方\n' + fighter('乙'));
                assert.equal(result.ok, true, result.error);
                assert.deepEqual(result.system.combatants.map((u) => [u.name, u.side]), [['甲', 'ally'], ['乙', 'enemy']]);
                for (const unit of result.system.combatants) {
                    assert.ok(unit.skills.some((skill) => skill.name.includes('破空斩')), JSON.stringify(unit.skills));
                    assert.ok(unit.skills.some((skill) => skill.name.includes('护身诀')), JSON.stringify(unit.skills));
                }
            });
        }
    }
    it('名单与详细章节阵营冲突时暂停，不改队', () => {
        const result = parseSituationReport(roster + '### 我方\n' + detail('甲') + '\n' + detail('乙'));
        assert.equal(result.ok, false);
        assert.equal(result.needsReview, true);
    });
    it('只有敌方时不能按人数把前半改为我方', () => {
        const result = parseSituationReport('## 敌方\n' + detail('甲') + '\n' + detail('乙'));
        assert.equal(result.ok, false);
        assert.equal(result.needsReview, true);
    });
    it('空名单不能回退到随意识别人名', () => {
        const result = parseSituationReport('## 参战人员名单\n### 参战\n无\n## 参战双方\n### 我方\n' + detail('描述甲') + '\n### 敌方\n' + detail('描述乙'));
        assert.equal(result.ok, false);
        assert.equal(result.needsReview, true);
    });
});

const SAMPLE = readFileSync(new URL('./fixtures/situation-report-sample.md', import.meta.url), 'utf8');

describe('parseSituationReport 真实汇报', () => {
    const result = parseSituationReport(SAMPLE);

    it('能解析成功', () => {
        assert.equal(result.ok, true, `解析失败：${result.error}`);
    });

    it('认出恰好 2 个参战者（不多不少）', () => {
        // 这是最关键的一条：早期版本把 `**状态**：`、`**内藏底牌（…）**：`、
        // `**临时加成/减益**：` 这些**字段名**也当成了角色，
        // 于是 2 个人被解析成 5 个，而且假角色的 HP 是凭空的。
        assert.equal(result.stats.units, 2, `参战者数量不对：${result.system.combatants.map((u) => u.name).join('、')}`);
    });

    it('名字与阵营都正确', () => {
        const q = result.system.combatants.find((u) => u.name === '淇');
        const paul = result.system.combatants.find((u) => u.name === '保罗·格雷拉特');
        assert.ok(q, '应当认出「淇」');
        assert.ok(paul, '应当认出「保罗·格雷拉特」');
        assert.equal(q.side, 'ally', '淇应当是我方');
        assert.equal(paul.side, 'enemy', '保罗应当是敌方');
    });

    it('双方都有，能开战', () => {
        assert.ok(result.stats.allies > 0, '必须有我方');
        assert.ok(result.stats.enemies > 0, '必须有敌方');
    });

    it('身份说明被记进 tier（可用于判断量级）', () => {
        const paul = result.system.combatants.find((u) => u.name === '保罗·格雷拉特');
        assert.ok(paul.tier.includes('上级剑士'), `tier 应当含身份说明，实际：${paul.tier}`);
    });

    it('血量按身份分出了量级（上级剑士 ≫ 五岁幼童）', () => {
        const q = result.system.combatants.find((u) => u.name === '淇');
        const paul = result.system.combatants.find((u) => u.name === '保罗·格雷拉特');
        assert.ok(q.attributes.HP.max > 0, '淇要有血量');
        assert.ok(paul.attributes.HP.max > 0, '保罗要有血量');
        assert.ok(
            paul.attributes.HP.max > q.attributes.HP.max * 3,
            `上级剑士的血量上限应当明显高于五岁幼童：保罗 ${paul.attributes.HP.max} vs 淇 ${q.attributes.HP.max}`,
        );
    });

    it('状态、技能、装备都被保留进 notes（续写与判定都要用）', () => {
        const paul = result.system.combatants.find((u) => u.name === '保罗·格雷拉特');
        assert.ok(paul.notes.includes('状态'), '应当有状态');
        assert.ok(paul.notes.includes('技能'), '应当有技能');
        assert.ok(paul.notes.includes('装备'), '应当有装备');
        assert.ok(paul.notes.includes('完好无伤'), '应当保留状态原文');
        assert.ok(paul.notes.includes('剑神流'), '应当保留技能原文');
        assert.ok(paul.notes.includes('硬木剑'), '应当保留装备原文');
    });

    it('临时加成被记下来（不能丢 —— 那会影响判定）', () => {
        const paul = result.system.combatants.find((u) => u.name === '保罗·格雷拉特');
        assert.ok(paul.notes.includes('压制出力') || paul.notes.includes('加成'), '应当保留临时加成');
    });

    it('保留性质说明与环境（叙事续写要用）', () => {
        assert.ok(result.system.overview.includes('切磋') || result.system.overview.includes('生死搏杀'));
        assert.ok(result.system.setting.includes('后院') || result.system.setting.includes('清晨'));
    });

    it('说明数值是估算的（不能让用户以为是原书数值）', () => {
        assert.ok(result.system.scale.includes('估算'), '必须声明数值来源是估算');
    });

    it('每个单位都标了数据出处', () => {
        for (const u of result.system.combatants) {
            assert.ok(u.source, `${u.name} 缺少 source`);
        }
    });

    it('解析日志会说明认出了谁', () => {
        assert.ok(result.logs.some((l) => l.includes('淇')), '日志里应当提到淇');
    });
});

describe('percentFromStatus 血量档位换算', () => {
    it('识别明确百分比', () => {
        assert.equal(percentFromStatus('还有 70% 的血').percent, 70);
    });

    it('识别中文成数', () => {
        assert.equal(percentFromStatus('约七成').percent, 70);
        assert.equal(percentFromStatus('三成血').percent, 30);
    });

    it('识别分数写法', () => {
        assert.equal(percentFromStatus('十之七八').percent, 70);
    });

    it('识别定性档位（从重到轻）', () => {
        assert.equal(percentFromStatus('濒死').percent, 10);
        assert.equal(percentFromStatus('重伤').percent, 25);
        assert.equal(percentFromStatus('轻伤').percent, 65);
    });

    it('满状态类描述给 100', () => {
        for (const text of ['满状态', '完好无伤', '毫发无伤', '未受伤', '精力充沛']) {
            assert.equal(percentFromStatus(text).percent, 100, `${text} 应当是满状态`);
        }
    });

    it('无法判断时保守给满血（不要让角色一开战就濒死）', () => {
        assert.equal(percentFromStatus('').percent, 100);
        assert.equal(percentFromStatus('说不清').percent, 100);
        assert.equal(percentFromStatus(null).percent, 100);
    });

    it('保留原文供追溯', () => {
        assert.equal(percentFromStatus('约七成血').note, '约七成血');
    });

    it('永远落在 1~100（不会给出 0 或负数）', () => {
        for (const text of ['0%', '重伤', '濒死', '-50%', '999%']) {
            const pct = percentFromStatus(text).percent;
            assert.ok(pct >= 1 && pct <= 100, `${text} 换算出 ${pct}，越界了`);
        }
    });
});

describe('parseSituationReport 健壮性', () => {
    it('空输入返回可读错误', () => {
        for (const input of ['', null, undefined, '   ']) {
            const r = parseSituationReport(input);
            assert.equal(r.ok, false);
            assert.ok(r.error);
        }
    });

    it('没有分节标题时给出可操作的错误提示', () => {
        const r = parseSituationReport('随便一段没有任何结构的文字，提到了甲和乙在打架。');
        assert.equal(r.ok, false);
        assert.ok(r.error.includes('我方') || r.error.includes('敌方'), '错误里应当说明需要什么格式');
    });

    it('只有我方时暂停并核对，不能凭空补出敌方', () => {
        const r = parseSituationReport(`## 二、参战双方
### 我方
**甲**（剑士）
- **状态**：满状态
**乙**（法师）
- **状态**：满状态
`);
        assert.equal(r.ok, false);
        assert.equal(r.needsReview, true);
        assert.match(r.error, /核对阵营/);
    });

    it('字段名不会被当成人名（回归）', () => {
        const r = parseSituationReport(`## 二、参战双方
### 我方
**甲**
- **状态**：满状态
- **内藏底牌（剧情明写为潜伏状态）**：有一颗珠子
- **注意**：他很强
- **临时加成/减益**：无
### 敌方
**乙**
- **状态**：满状态
`);
        assert.equal(r.ok, true, r.error);
        assert.equal(r.stats.units, 2, `不该把字段名当角色：${r.system.combatants.map((u) => u.name).join('、')}`);
    });

    it('名字里带点的（保罗·格雷拉特）不会被拆开', () => {
        const r = parseSituationReport(`## 二、参战双方
### 我方
**甲**
- **状态**：满状态
### 敌方
**保罗·格雷拉特**（剑士）
- **状态**：满状态
`);
        assert.equal(r.ok, true, r.error);
        const names = r.system.combatants.map((u) => u.name);
        assert.ok(names.includes('保罗·格雷拉特'), `应保留完整名字，实际：${names.join('、')}`);
    });

    it('中性标题（参战双方）不会被当成阵营', () => {
        const r = parseSituationReport(`## 二、参战双方
### 我方
**甲**
- **状态**：满状态
### 敌方
**乙**
- **状态**：满状态
`);
        assert.equal(r.system.combatants.find((u) => u.name === '甲').side, 'ally');
        assert.equal(r.system.combatants.find((u) => u.name === '乙').side, 'enemy');
    });

    it('「战场环境」之后的内容不会被当成角色', () => {
        const r = parseSituationReport(`## 二、参战双方
### 我方
**甲**
- **状态**：满状态
### 敌方
**乙**
- **状态**：满状态
## 三、战场环境
**后院**
- **地形**：泥土地
`);
        assert.equal(r.stats.units, 2, `环境描述里的人不该被当角色：${r.system.combatants.map((u) => u.name).join('、')}`);
    });

    it('解析结果能被归一化（结构合法）', async () => {
        const { normalizePowerSystem } = await import('../src/core/schema.js');
        const r = parseSituationReport(SAMPLE);
        const system = normalizePowerSystem(r.system);
        assert.equal(system.combatants.length, 2);
        for (const u of system.combatants) {
            assert.ok(u.attributes.HP.max > 0, `${u.name} 的 HP 上限应当 > 0`);
            assert.ok(u.attributes.Atk.max > 0, `${u.name} 的攻击应当 > 0`);
        }
    });
});
