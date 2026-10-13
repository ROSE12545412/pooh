/**
 * 技能解析的测试 —— 修「已经写明了技能和判定优势，开战以后所有人都是普通攻击」。
 *
 * 用户的原话：「这是模型读到的太笼统不说而且技能没有读进去，开战以后所有人都是普通攻击。
 * 简单来说你要求掷骰模型干的活太少了，太笼统没法打」
 *
 * 两个根因：
 *  1. 汇报里的技能常写成**缩进子列表**，而解析器只认「键：值」在同一行 → 整段技能丢失
 *  2. 就算抠出技能名，**没有威力/命中/消耗**，引擎也没法用 → 照样只能普攻
 *
 * 这里锁住「技能必须变成能掷骰的数据」这条底线。
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
    buildFallbackSkill,
    estimatePower,
    parsePipeSkill,
    estimateRating,
    parseAdvantage,
    parseEffects,
    parseMpCost,
    parseSkillBlock,
    parseSkillLine,
    parseTarget,
} from '../src/llm/skill-parse.js';
import { parseSituationReport } from '../src/llm/report-parser.js';
import { normalizeCombatant } from '../src/core/schema.js';

/** 用户给的汇报形态（缩进子列表 + 判定优势 + 蓝耗）。 */
const REPORT = `## 参战双方

### 我方
**【玩家】淇**（保罗之子／转生者，五岁幼童）
- 位阶：无阶（表象为凡人幼童）
- 血量：满状态
- 魔量：极充沛
- 技能：
  - 天道核：心脏内隐的终极本源（+10判定加值，固定消耗0点蓝量）
  - 斩天剑意：隐匿不可知的神兵，撕裂一切屏障（绝对正面优势+10，固定消耗100点蓝量）
  - 空间瞬移：无视维度的瞬时位移（+10，固定消耗50点蓝量）
- 武器与装备：练习木剑

### 敌方
**保罗·格雷拉特**（生父／前S级冒险者）
- 位阶：剑神流上级剑士
- 血量：满状态
- 技能：
  - 剑神流·直线突刺：低重心蹬地发力（先手判定+5，固定消耗30点斗气魔量）
  - 水神流·化劲卸力：借躯干微调化解（受击减伤+4，固定消耗25点）
  - 北神流·借力变招：虚实转换（破防+3，固定消耗20点）
- 武器与装备：硬木训练剑`;

describe('缩进子列表的技能必须被读进来（这是「只会普攻」的根因）', () => {
    const result = parseSituationReport(REPORT);

    it('解析成功', () => {
        assert.equal(result.ok, true, result.error);
    });

    it('玩家的 3 个技能全部进 skills（不是只在 notes 里）', () => {
        const qi = result.system.combatants.find((u) => u.name === '淇');
        assert.ok(qi, '应当认出淇');
        assert.equal(qi.skills.length, 3, `技能数不对：${qi.skills.map((s) => s.name).join('、')}`);
        const names = qi.skills.map((s) => s.name);
        for (const n of ['天道核', '斩天剑意', '空间瞬移']) {
            assert.ok(names.includes(n), `缺少技能「${n}」`);
        }
    });

    it('敌方的 3 个技能也全部进 skills', () => {
        const paul = result.system.combatants.find((u) => u.name === '保罗·格雷拉特');
        assert.equal(paul.skills.length, 3, `技能数不对：${paul.skills.map((s) => s.name).join('、')}`);
    });

    it('每个技能都有**可掷骰的数值**（威力/命中/消耗）', () => {
        for (const u of result.system.combatants) {
            for (const s of u.skills) {
                assert.ok(s.power > 0, `${s.name} 缺威力`);
                assert.ok(s.aim > 0, `${s.name} 缺命中`);
                assert.equal(typeof s.cost, 'number', `${s.name} 缺消耗`);
                assert.ok(s.effects.length > 0, `${s.name} 缺效果类型`);
            }
        }
    });

    it('判定优势被读出来并保留（用户要求「判定优势必须明确」）', () => {
        const qi = result.system.combatants.find((u) => u.name === '淇');
        const tianDao = qi.skills.find((s) => s.name === '天道核');
        assert.equal(tianDao.advantage, 10, '天道核应当是 +10 判定优势');
        const paul = result.system.combatants.find((u) => u.name === '保罗·格雷拉特');
        const thrust = paul.skills.find((s) => s.name.includes('直线突刺'));
        assert.equal(thrust.advantage, 5, '直线突刺应当是 +5');
    });

    it('蓝耗被读出来（有固定消耗）', () => {
        const qi = result.system.combatants.find((u) => u.name === '淇');
        assert.equal(qi.skills.find((s) => s.name === '天道核').cost, 0, '被动应当是 0 消耗');
        assert.equal(qi.skills.find((s) => s.name === '斩天剑意').cost, 100);
        assert.equal(qi.skills.find((s) => s.name === '空间瞬移').cost, 50);
    });

    it('判定优势换算进了命中（aim 高于基准 100）', () => {
        const qi = result.system.combatants.find((u) => u.name === '淇');
        const strong = qi.skills.find((s) => s.name === '斩天剑意');
        assert.ok(strong.aim > 100, `+10 优势的技能命中应当 >100，实际 ${strong.aim}`);
    });

    it('技能全部能通过 schema 归一化（不会在下一步又丢掉）', () => {
        for (const u of result.system.combatants) {
            const norm = normalizeCombatant(u);
            assert.equal(norm.skills.length, u.skills.length, `${u.name} 的技能在归一化时丢了`);
            for (const s of norm.skills) {
                assert.ok(s.power > 0, '归一化后威力丢了');
                assert.equal(typeof s.advantage, 'number', 'advantage 字段应当在 schema 里保留');
            }
        }
    });
});

describe('位阶必须转成可比较的战力评分（用户要求「战力差距必须明确」）', () => {
    const result = parseSituationReport(REPORT);

    it('每个人都拿到了评分（模型没给也要推定）', () => {
        for (const u of result.system.combatants) {
            assert.ok(u.powerRating.rating > 0, `${u.name} 没有战力评分`);
            assert.ok(u.powerRating.basis, `${u.name} 没有评分依据说明`);
        }
    });

    it('位阶高的评分明显更高（差距必须拉得开）', () => {
        const qi = result.system.combatants.find((u) => u.name === '淇');
        const paul = result.system.combatants.find((u) => u.name === '保罗·格雷拉特');
        assert.ok(
            paul.powerRating.rating > qi.powerRating.rating,
            `上级剑士(${paul.powerRating.rating}) 应当高于无阶幼童(${qi.powerRating.rating})`,
        );
        assert.ok(
            paul.powerRating.rating - qi.powerRating.rating >= 30,
            '差距应当足够大，否则战斗手感拉不开',
        );
    });

    it('estimateRating 覆盖常见位阶词', () => {
        assert.ok(estimateRating('天花板').rating >= 90);
        assert.ok(estimateRating('剑神流上级剑士').rating >= 75);
        assert.ok(estimateRating('水神流中级剑士').rating >= 40);
        assert.ok(estimateRating('无阶幼童').rating <= 20);
    });
});

describe('parseAdvantage 判定优势换算', () => {
    it('读明确数字', () => {
        assert.equal(parseAdvantage('+10判定加值').bonus, 10);
        assert.equal(parseAdvantage('绝对正面优势+10').bonus, 10);
        assert.equal(parseAdvantage('招架与格挡判定+4').bonus, 4);
        assert.equal(parseAdvantage('破防+3').bonus, 0, '破防数值不冒充命中加值');
    });

    it('没有明确数字时不把定性措辞伪造成骰子加值', () => {
        for (const text of ['绝对正面优势', '显著正面优势', '较高正面优势', '一定正面优势']) {
            assert.equal(parseAdvantage(text).bonus, 0);
        }
    });

    it('认不出来给 0，不乱猜', () => {
        assert.equal(parseAdvantage('').bonus, 0);
        assert.equal(parseAdvantage('说明文字').bonus, 0);
    });

    it('明确的正负加值完整保留，不因世界战力尺度被静默截断', () => {
        assert.equal(parseAdvantage('+999判定').bonus, 999);
        assert.equal(parseAdvantage('-999判定').bonus, -999);
    });
});

describe('parseMpCost 蓝耗解析', () => {
    it('读各种写法', () => {
        assert.equal(parseMpCost('固定消耗0点蓝量'), 0);
        assert.equal(parseMpCost('固定消耗100点蓝量'), 100);
        assert.equal(parseMpCost('固定消耗20点斗气魔量'), 20);
        assert.equal(parseMpCost('消耗 30 MP'), 30);
        assert.equal(parseMpCost('25点斗气'), 25);
    });

    it('「0点」不该吃掉「100点」—— 先抓数字再判无消耗（真实 bug 的回归）', () => {
        // 早期版本先测 /0\s*点/，而「固定消耗100点蓝量」含「0点」子串 → 被判成 0
        assert.equal(parseMpCost('固定消耗100点蓝量'), 100, '100 不能被误判成 0');
        assert.equal(parseMpCost('固定消耗10点'), 10, '10 也不能');
    });

    it('「无消耗」这类才给 0', () => {
        assert.equal(parseMpCost('无消耗'), 0);
        assert.equal(parseMpCost('不消耗魔力'), 0);
    });

    it('没有消耗信息时给 0', () => {
        assert.equal(parseMpCost(''), 0);
        assert.equal(parseMpCost('效果描述'), 0);
    });
});

describe('parseEffects 技能性质分类', () => {
    it('攻击技不该因为描述里有「屏障」被归成护盾', () => {
        // 「撕裂一切屏障」—— 这是攻击技
        const effects = parseEffects('隐匿不可知的神兵，撕裂一切屏障', 10);
        assert.ok(effects.includes('damage'), '应当包含伤害');
        assert.ok(!effects.includes('shield'), '不该被归成护盾');
    });

    it('真正的防御技归成护盾', () => {
        const effects = parseEffects('以剑身斜向偏转敌方冲击，招架与格挡', 4);
        assert.ok(effects.includes('shield'));
    });

    it('位移类不是伤害', () => {
        const effects = parseEffects('无视维度的瞬时位移', 10);
        assert.deepEqual(effects, ['buff']);
    });

    it('治疗类不是伤害', () => {
        const effects = parseEffects('治愈骨裂、深度外伤并迅速止血', 4);
        assert.ok(effects.includes('heal'));
        assert.ok(!effects.includes('damage'));
    });

    it('威慑类归成减益', () => {
        assert.ok(parseEffects('以人母威严进行心理封锁威慑', 3).includes('debuff'));
    });
});

describe('parseTarget 目标范围', () => {
    it('群攻关键词', () => {
        assert.equal(parseTarget('对范围内敌人'), 'group');
    });
    it('默认单体', () => {
        assert.equal(parseTarget('一次斩击'), 'single');
    });
});

describe('estimatePower 威力按位阶推导（不是编造）', () => {
    it('位阶越高威力越大', () => {
        const weak = estimatePower('无阶幼童', 0);
        const mid = estimatePower('中级剑士', 0);
        const strong = estimatePower('上级剑士', 0);
        assert.ok(mid > weak, '中级应当高于无阶');
        assert.ok(strong > mid, '上级应当高于中级');
    });

    it('命中加值不同时抬高伤害威力', () => {
        assert.equal(estimatePower('中级剑士', 10), estimatePower('中级剑士', 0));
    });

    it('「终极/不可知」这类性质再抬一档', () => {
        const normal = estimatePower('无阶幼童 普通剑技', 10);
        const ultimate = estimatePower('无阶幼童 斩天剑意 隐匿不可知的神兵', 10);
        assert.ok(ultimate > normal, '终极技应当明显强于普通技');
    });

    it('结果落在合理区间（不会打出天文数字）', () => {
        for (const t of ['无阶幼童', '中级剑士', '上级剑士', '天花板 宇宙最强']) {
            const p = estimatePower(t, 10);
            assert.ok(p >= 20 && p <= 1000, `${t} 推出 ${p}，越界了`);
        }
    });
});

describe('parseSkillLine 单行解析的宽容度', () => {
    it('各种写法都能认', () => {
        const cases = [
            '天道核：提供无穷魔力（+10判定加值，固定消耗0点蓝量）',
            '- 斩天剑意：撕裂屏障（绝对正面优势+10，固定消耗100点蓝量）',
            '水神流·流水架势（招架判定+4，消耗20点斗气）',
            '中级治愈术',
        ];
        for (const text of cases) {
            const s = parseSkillLine(text);
            assert.ok(s, `应当能解析：${text}`);
            assert.ok(s.name, `应当有名字：${text}`);
            assert.ok(s.power > 0, `应当有威力：${text}`);
        }
    });

    it('说明性文字不会被当成技能', () => {
        for (const text of ['※其余技艺未提及', '说明：以上为估算', '暂无']) {
            assert.equal(parseSkillLine(text), null, `不该被当成技能：${text}`);
        }
    });

    it('同一行里用分号分隔的多个技能会拆开', () => {
        const skills = parseSkillBlock(['斩击：一次快斩（+3，固定消耗10点）；突刺：直线刺击（+5，固定消耗20点）']);
        assert.equal(skills.length, 2, `应当拆成 2 个：${skills.map((s) => s.name).join('、')}`);
    });

    it('保留全部有效技能，不把最低3条误当上限也不截掉第9条以后', () => {
        const many = Array.from({ length: 20 }, (_, i) => `技能${i}：效果（+2，固定消耗5点）`);
        const skills = parseSkillBlock(many);
        assert.equal(skills.length, 20);
        assert.deepEqual(skills.map(skill => skill.name), Array.from({ length: 20 }, (_, i) => `技能${i}`));
    });

    it('空输入不崩', () => {
        assert.equal(parseSkillLine(''), null);
        assert.equal(parseSkillLine(null), null);
        assert.deepEqual(parseSkillBlock(null), []);
        assert.deepEqual(parseSkillBlock([]), []);
    });
});


describe('推辞式文字不能被当成技能（用户截图里的两条）', () => {
    /**
     * 用户截图里战斗按钮上显示了这两个「技能」：
     *   「剧情只提到她是**中级治愈术士** · 威170 · 耗0」
     *   「具体术式**未展开**——未知。 · 威170 · 耗0」
     * 它们其实是模型的免责声明，被当成了技能名。
     */

    it('「剧情只提到…」这类被丢弃', () => {
        assert.equal(parseSkillLine('剧情只提到她是**中级治愈术士**'), null);
        assert.equal(parseSkillLine('具体术式**未展开**——未知。'), null);
        assert.equal(parseSkillLine('剧情中未施展'), null);
        assert.equal(parseSkillLine('**剧情明确其存在；具体加值与蓝耗未提及**'), null);
        assert.equal(parseSkillLine('※其余技艺名称与蓝耗剧情未提及'), null);
        assert.equal(parseSkillLine('（剧情明确其存在）'), null);
    });

    it('真正的技能仍然能识别', () => {
        assert.ok(parseSkillLine('中级治愈术：治愈骨裂、深度外伤并迅速止血（医疗判定+4，固定消耗25点蓝量）'));
        assert.ok(parseSkillLine('斩天剑意：撕裂屏障（+10，固定消耗100点蓝量）'));
        assert.ok(parseSkillLine('剑神流·直线突刺：低重心蹬地发力（先手判定+5，固定消耗30点斗气魔量）'));
    });
});



describe('表格格式（管道分隔）—— 现在的主力路径', () => {
    /**
     * 用户的关键意见：「你修解析器不如完善开战时发给正文的模板让它输出更规范一些，
     * 毕竟千卡千类，你只添加解析三个职业是不够的」。
     *
     * 所以现在的分工是：**提示词把格式规范到没法含糊**（管道分隔的表格行、
     * 效果类型给闭集、威力消耗要求纯数字），解析器只老实读它。
     */

    it('读出全部五列', () => {
        const s = parsePipeSkill('天道核｜增益｜120｜0｜心脏内隐的终极本源，提供无穷魔力');
        assert.ok(s, '应当能解析');
        assert.equal(s.name, '天道核');
        assert.equal(s.power, 120);
        assert.equal(s.cost, 0);
        assert.equal(s.description, '心脏内隐的终极本源，提供无穷魔力');
        assert.deepEqual(s.effects.map((e) => e.type), ['buff']);
    });

    it('模型给的威力**直接用**，不做二次估算', () => {
        // 这是「规范模板」最大的好处：数值来自模型，不是解析器猜的
        const s = parsePipeSkill('斩天剑意｜伤害｜880｜100｜撕裂一切屏障');
        assert.equal(s.power, 880, '表格里写 880 就应当得到 880');
        assert.equal(s.cost, 100);
    });

    it('效果类型按闭集读取', () => {
        for (const [word, type] of [
            ['伤害', 'damage'],
            ['治疗', 'heal'],
            ['护盾', 'shield'],
            ['增益', 'buff'],
            ['减益', 'debuff'],
            ['控制', 'control'],
            ['持续伤害', 'dot'],
        ]) {
            const s = parsePipeSkill(`某技能｜${word}｜100｜10｜说明`);
            assert.ok(s, `${word} 应当能解析`);
            assert.deepEqual(s.effects.map((e) => e.type), [type], `${word} 应当映射到 ${type}`);
        }
    });

    it('全角与半角竖线都认', () => {
        assert.ok(parsePipeSkill('技能甲｜伤害｜100｜10｜说明'));
        assert.ok(parsePipeSkill('技能乙|伤害|100|10|说明'));
        assert.ok(parsePipeSkill('技能丙 ｜ 伤害 ｜ 100 ｜ 10 ｜ 说明'));
    });

    it('列数不足时不硬解析（那多半是普通文字）', () => {
        assert.equal(parsePipeSkill('普通的一行文字'), null);
        assert.equal(parsePipeSkill('只有｜一列'), null);
    });

    it('推辞式文字在表格格式里也被挡掉', () => {
        assert.equal(parsePipeSkill('剧情未展开｜未知｜0｜0｜未知'), null);
    });

    it('整块解析：多行全部读到', () => {
        const skills = parseSkillBlock([
            '天道核｜增益｜120｜0｜提供无穷魔力',
            '斩天剑意｜伤害｜880｜100｜撕裂一切屏障',
            '空间瞬移｜增益｜150｜50｜无视维度的位移',
        ]);
        assert.equal(skills.length, 3);
    });
});

describe('端到端：新的表格格式汇报', () => {
    const REPORT_WITH_TABLE = `## 参战双方
### 我方
**【玩家】淇**（保罗之子）
- 位阶：无阶
- 血量：满状态
- 技能：
  - 天道核｜增益｜120｜0｜心脏内隐的终极本源
  - 斩天剑意｜伤害｜880｜100｜引动不可知神兵
  - 空间瞬移｜增益｜150｜50｜无视维度的瞬时位移
### 敌方
**塞妮丝·格雷拉特**（生母／治疗术师）
- 位阶：中级治疗术师
- 血量：满状态
- 技能：
  - 中级治愈术｜治疗｜180｜25｜治愈骨裂与深度外伤
  - 群体回复｜治疗｜150｜40｜为周围同伴恢复体力
  - 净化术｜治疗｜120｜20｜解除毒素与异常状态`;

    const result = parseSituationReport(REPORT_WITH_TABLE);

    it('解析成功', () => {
        assert.equal(result.ok, true, result.error);
    });

    it('每个人的技能都读全了', () => {
        for (const u of result.system.combatants) {
            assert.equal(u.skills.length, 3, `${u.name} 的技能数不对`);
        }
    });

    it('威力来自模型，不是估算的', () => {
        const qi = result.system.combatants.find((u) => u.name === '淇');
        assert.equal(qi.skills.find((s) => s.name === '斩天剑意').power, 880);
    });

    it('治疗师拿到的是治疗技能（因为模板要求按身份写）', () => {
        const healer = result.system.combatants.find((u) => u.name === '塞妮丝·格雷拉特');
        for (const s of healer.skills) {
            assert.ok(
                s.effects.some((e) => e.type === 'heal'),
                `${s.name} 应当是治疗技`,
            );
        }
    });

    it('没有推辞式技能名', () => {
        for (const u of result.system.combatants) {
            for (const s of u.skills) {
                assert.ok(!/剧情|未展开|未知|只提到/.test(s.name), `技能名不该是推辞：${s.name}`);
            }
        }
    });
});

describe('提示词模板的规范程度（这才是治本的地方）', () => {
    const promptSource = readFileSync(new URL('../src/llm/scene-prompt.js', import.meta.url), 'utf8');

    it('技能给出管道分隔的模板行', () => {
        assert.ok(promptSource.includes('｜'), '模板里应当有管道分隔的技能行');
        assert.ok(
            /技能名）｜（范围）｜（效果类型）｜（威力）｜（消耗）｜（持续回合）｜（回合豁免DC）｜（效果说明）/.test(promptSource),
            '应当给出完整的八列模板',
        );
    });

    it('效果类型给出闭集（不能自创）', () => {
        assert.ok(promptSource.includes('伤害 / 治疗 / 护盾 / 增益 / 减益 / 控制 / 持续伤害'), '应当列出闭集');
        assert.ok(promptSource.includes('复合效果用 + 连接'), '应当允许受支持效果的明确组合');
        assert.ok(promptSource.includes('骰点减益'), '应当明确骰点减益，而不是只写泛化减益');
    });

    it('威力与消耗要求纯数字，并给量级参照', () => {
        assert.ok(promptSource.includes('非负整数，纯控制/减益可填 0'), '应当允许明确0威力的纯状态技');
        assert.ok(promptSource.includes('普通伤害技能 80~200'), '应当给伤害量级参照');
        assert.ok(promptSource.includes('写**纯数字**'), '消耗应当要求纯数字');
    });

    it('明令禁止「未知」「未提及」这类占位', () => {
        assert.ok(promptSource.includes('不要写「未知」'), '应当禁止推辞');
        assert.ok(promptSource.includes('不要用「未提及」占位'), '应当禁止占位');
    });

    it('要求位阶能排出高下（不让所有人同一档）', () => {
        assert.ok(promptSource.includes('不要让所有人都是同一档'), '应当要求拉开位阶差距');
    });

    it('要求技能符合身份，并明确「不要给所有人套同一套攻击技」', () => {
        assert.ok(promptSource.includes('不要给所有人套同一套攻击技'), '应当禁止照搬');
        assert.ok(promptSource.includes('当前世界设定、能力来源、训练经历、装备和身体条件'), '应当按当前角色设定补足技能');
    });
});

describe('兜底技能（刻意不按职业猜）', () => {
    it('给一条中性的通用技能，而不是猜职业', () => {
        const skills = buildFallbackSkill({ name: '某人', tier: '中级剑士' });
        assert.equal(skills.length, 1);
        assert.equal(skills[0].name, '全力一击');
        assert.ok(skills[0].source.includes('兜底'), '应当标明是兜底生成的');
        assert.ok(skills[0].power > 0, '应当有威力');
    });

    it('端到端：完全读不出技能时也不会只能普攻', () => {
        const report = `## 参战双方
### 我方
**【玩家】甲**（剑士）
- 位阶：上级剑士
- 血量：满状态
- 技能：
  - 剧情未展开
### 敌方
**乙**（法师）
- 位阶：中级法师
- 血量：满状态
- 技能：
  - 未知`;
        const r = parseSituationReport(report);
        assert.equal(r.ok, true, r.error);
        for (const u of r.system.combatants) {
            assert.ok(u.skills.length >= 1, `${u.name} 应当至少有兜底技能`);
            assert.ok(u.skills[0].power > 0, '兜底技能也要有威力');
        }
    });
});
